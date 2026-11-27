// Claude Agent (02 §8.10, CAG 2026-10-31): the add-account flow and the accounts page's section, one lazy chunk that
// add-account.tsx and index.tsx load with `lazy` (PF5). The route runs the user's own, unmodified Claude Code:
// `claudeAgent.setup` makes a login folder, `claudeAgent.login` opens Claude Code's own login window on this PC (or
// the user runs the shown command in 명령 프롬프트 or PowerShell), and own only learns whether a login is there and its
// masked e-mail. Several accounts (phase 2) share one transcript folder; a conversation moves between them by hand only
// (the switcher, the 계정·한도 tab), so nothing here offers an automatic switch. The section also splits this PC's
// Claude login folders between the Claude subscription (claude-auth) and Claude Agent: one route per folder. Setup,
// login, removal and the split are this PC's (`local`); another device sees why it cannot.
import type { Account } from "@own/protocol"
import { claudeAccountsText } from "./claude-accounts-strings"
import { createSignal, For, onCleanup, Show } from "solid-js"
import { useData } from "@/data"
import type { OwnOutput } from "@/data/rpc"
import { useHost } from "@/host"
import { useI18n, type I18n } from "@/i18n"
import { requestNewSession } from "@/limits/intents"
import { copyText, createStatus, Dialog, Dot, Menu, Notice, ProviderMark, Spinner, StatusLine, Tag } from "@/limits/kit"
import { policyState } from "@/limits/shared"
import { AccountLimits } from "@/limits/summary"
import { focusCompaction } from "@/settings/focus"
import type { FeatureText } from "@/queue/text"
import { useRouter } from "@/routing/router"
import { minuteNow } from "@/shell/clock"
import { CLAUDE_CODE_SETUP_URL, useClaudeAgentText, type ClaudeAgentKey } from "./claude-agent-strings"
import { errorData, errorMessage, errorType } from "./errors"
import { compactionSummary, compactionSummaryText, kindLabel, planLabel } from "./model"

type Status = OwnOutput<"claudeAgent.status">
type AccountStatus = Status["accounts"][number]
type Folder = OwnOutput<"claudeAgent.folders.list">["folders"][number]

/** How often the login's progress is asked while one can still arrive (the window, or the terminal command). */
const POLL_MS = 1_500

const INTRO: readonly ClaudeAgentKey[] = [
  "own.claudeAgent.intro.cli",
  "own.claudeAgent.intro.login",
  "own.claudeAgent.intro.folder",
  "own.claudeAgent.intro.manual",
]

/**
 * The add-account step: what the route is, then a login folder (`claudeAgent.setup`: the first account, an account
 * still waiting for its login, or another one), then its login. Without Claude Code on this PC it links the install
 * guide and checks again on request.
 */
export function ClaudeAgentFlow(props: { readonly onBack: () => void; readonly onClose: () => void }) {
  const data = useData()
  const i18n = useI18n()
  const text = useClaudeAgentText()
  const router = useRouter()
  const own = data.local().own
  const [status, setStatus] = createSignal<Status>()
  const [target, setTarget] = createSignal<string>()
  const problem = createStatus()
  const thisPc = () => own.rpc.allowed("claudeAgent.setup")
  const fail = (error: unknown) => void problem.error(agentFailure(i18n, text, error))
  // An account still waiting for its login is the one to sign in; otherwise a new one (the first, or another).
  const prepare = async () => {
    const known = await own.rpc.call("claudeAgent.status", {}).catch(fail)
    if (!known) return
    const waiting = known.accounts.find((item) => !item.loggedIn)
    if (known.cli !== null && waiting) {
      problem.clear()
      setTarget(waiting.accountID)
      return setStatus(known)
    }
    if (known.cli === null) return setStatus(known)
    const next = await own.rpc.call("claudeAgent.setup", { add: known.accounts.length > 0 }).catch(fail)
    if (!next) return
    problem.clear()
    setTarget(next.created ?? next.accounts[0]?.accountID)
    setStatus(next)
  }
  if (thisPc()) void prepare()
  const account = () => status()?.accounts.find((item) => item.accountID === target())
  return (
    <div class="flex flex-col gap-3" data-testid="claude-agent-flow">
      <ul class="m-0 flex list-disc flex-col gap-1 pl-5 text-[13px] leading-5" data-testid="claude-agent-intro">
        <For each={INTRO}>{(key) => <li>{text(key)}</li>}</For>
      </ul>
      <Show
        when={thisPc()}
        fallback={
          <Notice tone="info" testid="claude-agent-pc-only">
            {text("own.claudeAgent.err.remote")}
          </Notice>
        }
      >
        <Show
          when={status()}
          fallback={
            <Show when={!problem.message()}>
              <p class="m-0 flex items-center gap-2 text-[13px] text-own-muted">
                <Spinner />
                {text("own.claudeAgent.preparing")}
              </p>
            </Show>
          }
        >
          {(current) => (
            <Show when={current().cli !== null} fallback={<CliMissing onRecheck={() => void prepare()} />}>
              <Show when={account()}>
                {(item) => (
                  <>
                    <FolderLine folder={item().folder} />
                    <LoginPanel status={current()} accountID={item().accountID} onStatus={setStatus} />
                  </>
                )}
              </Show>
            </Show>
          )}
        </Show>
      </Show>
      <StatusLine status={problem} testid="claude-agent-problem" />
      <div class="flex justify-end gap-2">
        <button type="button" class="own-btn" onClick={() => props.onBack()}>
          {i18n.t("own.acct.back")}
        </button>
        <Show when={account()?.loggedIn ? account() : undefined}>
          {(item) => (
            <button
              type="button"
              class="own-btn"
              data-testid="claude-agent-new-session"
              onClick={() => {
                // A new conversation on this account: it becomes the route's default first.
                void own.rpc.call("claudeAgent.default.set", { accountID: item().accountID }).catch(() => undefined)
                requestNewSession({ accountID: item().accountID, providerID: "claude-agent" })
                props.onClose()
                router.navigate({ name: "home" })
              }}
            >
              {i18n.t("own.acct.newSessionWith")}
            </button>
          )}
        </Show>
        <button
          type="button"
          class="own-btn"
          data-variant="primary"
          onClick={() => props.onClose()}
          data-testid="claude-agent-close"
        >
          {i18n.t("own.kit.close")}
        </button>
      </div>
    </div>
  )
}

/**
 * The accounts page's Claude Agent section: one card per account (the default first), `Claude Agent 계정 추가`, and
 * the folder split between the Claude subscription and Claude Agent.
 */
export function ClaudeAgentSection(props: {
  readonly ids: readonly string[]
  /** `이름 바꾸기` (PF 2026-11-03): the accounts page's rename dialog, as for every other account. */
  readonly onRename?: (accountID: string) => void
}) {
  const data = useData()
  const i18n = useI18n()
  const text = useClaudeAgentText()
  const own = data.local().own
  const [adding, setAdding] = createSignal(false)
  return (
    <section class="own-psec" data-kind="claude-agent" data-testid="claude-agent-section">
      <div class="own-psec-head">
        <ProviderMark kind="claude-agent" />
        <h2>{kindLabel(i18n, "claude-agent")}</h2>
        <span class="ml-auto">
          <Tag tone="soft">{i18n.t("own.accounts.type.subscription")}</Tag>
        </span>
      </div>
      <For each={props.ids}>
        {(id) => (
          <ClaudeAgentCard
            id={id}
            others={props.ids.filter((other) => other !== id)}
            {...(props.onRename ? { onRename: props.onRename } : {})}
          />
        )}
      </For>
      <PoolLine />
      <Show when={own.rpc.allowed("claudeAgent.setup")}>
        <div class="mt-1">
          <button
            type="button"
            class="own-btn"
            data-size="sm"
            onClick={() => setAdding(true)}
            data-testid="claude-agent-add"
          >
            {text("own.claudeAgent.add")}
          </button>
        </div>
      </Show>
      <Show when={own.rpc.allowed("claudeAgent.folders.list")}>
        <FoldersPanel />
      </Show>
      <Show when={adding()}>
        <AddDialog onClose={() => setAdding(false)} />
      </Show>
    </section>
  )
}

/** Where a Claude Agent account stands, for its card's status tag. */
export function agentState(account: Pick<Account.View, "status" | "claudeAgent">) {
  if (account.status === "misconfigured" || account.claudeAgent?.cli === false) return "cli"
  if (account.status === "needs_reauth" || account.status === "auth_failed" || account.claudeAgent?.loggedIn === false)
    return "login"
  return "ready"
}

/** `Max 요금제`; `API 키` for a login without a subscription (`null`); nothing while Claude Code has not said. */
export function agentPlan(text: FeatureText<ClaudeAgentKey>, plan: string | null | undefined) {
  if (plan === undefined) return undefined
  if (plan === null) return text("own.claudeAgent.planKey")
  return text("own.claudeAgent.plan", { plan: planLabel(plan) })
}

/** The card's identity line, `na***@gmail.com · Max 요금제`; empty before the first login. */
export function agentIdentity(text: FeatureText<ClaudeAgentKey>, account: Pick<Account.View, "claudeAgent">) {
  return [account.claudeAgent?.email, agentPlan(text, account.claudeAgent?.plan)]
    .filter((part): part is string => !!part)
    .join(" · ")
}

/**
 * A login of `accountID` can still arrive: the window is open for it, or it is not logged in yet (the terminal command
 * works any time).
 */
export function awaitingLogin(status: Status, accountID: string) {
  const account = status.accounts.find((item) => item.accountID === accountID)
  if (status.cli === null || !account) return false
  return (status.login === "waiting" && status.loginAccount === accountID) || !account.loggedIn
}

/** The route's refusals in the screen's words; anything else as the accounts page says it. */
export function agentFailure(i18n: I18n, text: FeatureText<ClaudeAgentKey>, error: unknown) {
  const type = errorType(error)
  if (type === "remote_managed") return text("own.claudeAgent.err.remote")
  if (type === "session_busy") return text("own.claudeAgent.err.busySession")
  const reason = type === "claude_account_unavailable" ? errorData<{ reason: string }>(error).reason : undefined
  if (reason === "busy") return text("own.claudeAgent.err.busy")
  if (reason === "cli_missing") return text("own.claudeAgent.cliMissing")
  if (reason !== undefined && reason in WHY) return text(WHY[reason as keyof typeof WHY])
  return errorMessage(i18n, error)
}

const WHY = {
  claude_code: "own.claudeAgent.folders.why.claude_code",
  slot: "own.claudeAgent.folders.why.slot",
  not_managed: "own.claudeAgent.folders.why.not_managed",
  busy: "own.claudeAgent.folders.why.busy",
  not_patched: "own.claudeAgent.folders.why.not_patched",
} as const satisfies Record<NonNullable<Folder["reason"]>, ClaudeAgentKey>

const STATE_TONE = { ready: "ok", login: "warn", cli: "danger" } as const

function ClaudeAgentCard(props: {
  readonly id: string
  readonly others: readonly string[]
  readonly onRename?: (accountID: string) => void
}) {
  const data = useData()
  const i18n = useI18n()
  const text = useClaudeAgentText()
  const own = data.local().own
  const [login, setLogin] = createSignal(false)
  const [remove, setRemove] = createSignal(false)
  const [reading, setReading] = createSignal(false)
  const router = useRouter()
  const status = createStatus()
  const thisPc = () => own.rpc.allowed("claudeAgent.login")
  const refresh = async () => {
    status.clear()
    setReading(true)
    await own.rpc
      .call("claudeAgent.limits.refresh", { accountID: props.id })
      .then(() => status.ok(text("own.claudeAgent.limitsDone")))
      .catch((error: unknown) => status.error(agentFailure(i18n, text, error)))
    setReading(false)
  }
  const makeDefault = (account: Account.View) =>
    own.rpc
      .call("claudeAgent.default.set", { accountID: account.id })
      .then(() => status.ok(text("own.claudeAgent.madeDefault", { account: account.label })))
      .catch((error: unknown) => status.error(agentFailure(i18n, text, error)))
  return (
    <Show when={own.state.accounts[props.id]}>
      {(account) => (
        <article
          class="own-acard"
          data-account-id={account().id}
          data-state={agentState(account())}
          data-default={account().claudeAgent?.default ? "" : undefined}
          data-testid="claude-agent-card"
        >
          <div class="flex flex-wrap items-center gap-2">
            <Dot color={account().color} />
            <span class="font-semibold">{account().label}</span>
            <Tag tone={STATE_TONE[agentState(account())]} testid="claude-agent-state">
              {text(`own.claudeAgent.state.${agentState(account())}`)}
            </Tag>
            <Show when={account().claudeAgent?.default && props.others.length > 0}>
              <Tag tone="soft" testid="claude-agent-default">
                {text("own.claudeAgent.default")}
              </Tag>
            </Show>
            <span class="ml-auto flex items-center gap-2 text-[12px] text-own-muted">
              <Show when={account().sessions}>
                {(sessions) => (
                  <span>{i18n.t("own.accounts.usage", { running: sessions().running, total: sessions().total })}</span>
                )}
              </Show>
              <Show when={props.onRename && own.rpc.allowed("accounts.update")}>
                <Menu
                  label={i18n.t("own.acct.menu", { account: account().label })}
                  testid="claude-agent-menu"
                  entries={() => [{ label: i18n.t("own.acct.rename"), onSelect: () => props.onRename?.(account().id) }]}
                />
              </Show>
            </span>
          </div>
          <Show when={agentIdentity(text, account())}>
            {(line) => (
              <p class="m-0 mt-1 text-[12.5px] text-own-muted" data-testid="claude-agent-identity">
                {line()}
              </p>
            )}
          </Show>
          <Show when={agentState(account()) === "cli"}>
            <div class="mt-2">
              <CliMissing />
            </div>
          </Show>
          <Show when={account().claudeAgent?.transcripts === "broken"}>
            <div class="mt-2">
              <Notice tone="warn" testid="claude-agent-transcripts-broken">
                {text("own.claudeAgent.transcriptsBroken")}
              </Notice>
            </div>
          </Show>
          <Show when={account().claudeAgent?.folder}>
            {(folder) => (
              <div class="mt-1.5">
                <FolderLine folder={folder()} />
              </div>
            )}
          </Show>
          {/* CAG-50: the account's own auto-compaction, set in 설정 > 자동 압축 like any account's. */}
          <p class="m-0 mt-1 flex flex-wrap items-center gap-2 text-[12px] text-own-muted" data-testid="account-compaction">
            {compactionSummaryText(
              i18n,
              compactionSummary(account().kind, account().compaction?.setting, policyState()?.policy.compaction?.byKind),
            )}
            <button
              type="button"
              class="own-link"
              onClick={() => {
                focusCompaction({ accountID: account().id })
                router.navigate({ name: "settings", section: "compaction" })
              }}
            >
              {i18n.t("own.lim.change")}
            </button>
          </p>
          <div class="mt-2.5">
            <AccountLimits
              surface="accounts"
              windows={own.state.quota[account().id]}
              kind="claude-agent"
              rates
              now={minuteNow}
            />
          </div>
          <p class="m-0 mt-2 text-[12px] text-own-muted">{text("own.claudeAgent.manual")}</p>
          <div class="mt-2 flex flex-wrap items-center gap-2">
            <Show when={thisPc()}>
              <button
                type="button"
                class="own-btn"
                data-size="sm"
                data-variant={agentState(account()) === "login" ? "primary" : undefined}
                onClick={() => setLogin(true)}
                data-testid="claude-agent-login"
              >
                {text("own.claudeAgent.relogin")}
              </button>
            </Show>
            <Show when={own.rpc.allowed("claudeAgent.limits.refresh")}>
              <button
                type="button"
                class="own-btn"
                data-size="sm"
                disabled={reading() || agentState(account()) !== "ready"}
                onClick={() => void refresh()}
                data-testid="claude-agent-limits"
              >
                <Show when={reading()}>
                  <Spinner />
                </Show>
                {text("own.claudeAgent.limits")}
              </button>
            </Show>
            <Show when={!account().claudeAgent?.default && own.rpc.allowed("claudeAgent.default.set")}>
              <button
                type="button"
                class="own-btn"
                data-size="sm"
                onClick={() => void makeDefault(account())}
                data-testid="claude-agent-make-default"
              >
                {text("own.claudeAgent.makeDefault")}
              </button>
            </Show>
            <Show
              when={thisPc()}
              fallback={<span class="text-[12px] text-own-muted">{text("own.claudeAgent.pcOnly")}</span>}
            >
              <button
                type="button"
                class="own-btn ml-auto"
                data-size="sm"
                data-variant="danger"
                onClick={() => setRemove(true)}
                data-testid="claude-agent-remove"
              >
                {text("own.claudeAgent.remove")}
              </button>
            </Show>
          </div>
          <StatusLine status={status} testid="claude-agent-card-status" />
          <Show when={login()}>
            <LoginDialog account={account()} onClose={() => setLogin(false)} />
          </Show>
          <Show when={remove()}>
            <RemoveDialog account={account()} others={props.others} onClose={() => setRemove(false)} />
          </Show>
        </article>
      )}
    </Show>
  )
}

/**
 * The login step of one account: `로그인 창 열기` (Claude Code's own login in a console window on this PC), or the
 * terminal command for 명령 프롬프트 and for PowerShell. While a login can still arrive it asks `claudeAgent.status`
 * every {@link POLL_MS} and stops when it unmounts. A window's failure or timeout shows only after this panel opened one
 * (the state keeps the last window's outcome).
 */
function LoginPanel(props: {
  readonly status: Status
  readonly accountID: string
  readonly onStatus: (next: Status) => void
}) {
  const data = useData()
  const i18n = useI18n()
  const text = useClaudeAgentText()
  const own = data.local().own
  const [opening, setOpening] = createSignal(false)
  const [started, setStarted] = createSignal(false)
  const problem = createStatus()
  const timer = { id: undefined as ReturnType<typeof setTimeout> | undefined, stopped: false }
  onCleanup(() => {
    timer.stopped = true
    clearTimeout(timer.id)
  })
  const poll = () => {
    clearTimeout(timer.id)
    timer.id = setTimeout(async () => {
      const next = await own.rpc.call("claudeAgent.status", {}).catch(() => undefined)
      if (timer.stopped) return
      if (next) props.onStatus(next)
      if (awaitingLogin(next ?? props.status, props.accountID)) poll()
    }, POLL_MS)
  }
  if (awaitingLogin(props.status, props.accountID)) poll()
  const open = async () => {
    problem.clear()
    setOpening(true)
    await own.rpc
      .call("claudeAgent.login", { accountID: props.accountID })
      .then((next) => {
        setStarted(true)
        props.onStatus(next)
        if (awaitingLogin(next, props.accountID)) poll()
      })
      .catch((error: unknown) => problem.error(agentFailure(i18n, text, error)))
    setOpening(false)
  }
  const account = (): AccountStatus | undefined =>
    props.status.accounts.find((item) => item.accountID === props.accountID)
  const mine = () => props.status.loginAccount === props.accountID
  return (
    <section class="flex flex-col gap-2" data-testid="claude-agent-login-panel" data-login={props.status.login}>
      <h3 class="m-0 text-[13.5px] font-semibold">{text("own.claudeAgent.login.title")}</h3>
      <Show
        when={account()?.loggedIn ? account() : undefined}
        fallback={
          <>
            <p class="m-0 text-[13px] leading-5">{text("own.claudeAgent.login.body")}</p>
            <div>
              <button
                type="button"
                class="own-btn"
                data-variant="primary"
                disabled={opening() || props.status.login === "waiting"}
                onClick={() => void open()}
                data-testid="claude-agent-login-open"
              >
                <Show when={opening()}>
                  <Spinner />
                </Show>
                {text("own.claudeAgent.login.open")}
              </button>
            </div>
            <Show when={props.status.login === "waiting" && mine()}>
              <p class="m-0 flex items-center gap-2 text-[13px]" data-testid="claude-agent-login-waiting">
                <Spinner />
                {text("own.claudeAgent.login.waiting")}
              </p>
            </Show>
            <Show
              when={started() && mine() && (props.status.login === "failed" || props.status.login === "timeout")}
            >
              <p class="m-0 text-[12.5px] text-own-danger" role="alert" data-testid="claude-agent-login-failed">
                {text(
                  props.status.login === "timeout" ? "own.claudeAgent.login.timeout" : "own.claudeAgent.login.failed",
                )}
              </p>
            </Show>
            <Show when={account()?.commands}>{(commands) => <CommandBox commands={commands()} />}</Show>
          </>
        }
      >
        {(item) => (
          <Notice tone="ok" testid="claude-agent-logged-in">
            <Show when={item().email} fallback={text("own.claudeAgent.login.doneNoEmail")}>
              {(email) => text("own.claudeAgent.login.done", { email: email() })}
            </Show>
            <Show when={agentPlan(text, item().plan)}>{(plan) => ` · ${plan()}`}</Show>
          </Notice>
        )}
      </Show>
      <StatusLine status={problem} testid="claude-agent-login-status" />
    </section>
  )
}

/** The card's `로그인`: the route's state first, then the same login step as the add flow. */
function LoginDialog(props: { readonly account: Account.View; readonly onClose: () => void }) {
  const data = useData()
  const i18n = useI18n()
  const text = useClaudeAgentText()
  const own = data.local().own
  const [status, setStatus] = createSignal<Status>()
  const problem = createStatus()
  void own.rpc
    .call("claudeAgent.status", {})
    .then(setStatus, (error: unknown) => problem.error(agentFailure(i18n, text, error)))
  return (
    <Dialog
      open
      title={text("own.claudeAgent.reloginTitle", { account: props.account.label })}
      onClose={() => props.onClose()}
      testid="claude-agent-login-dialog"
      footer={
        <button type="button" class="own-btn" data-variant="primary" onClick={() => props.onClose()}>
          {i18n.t("own.kit.close")}
        </button>
      }
    >
      <Show when={status()}>
        {(current) => (
          <Show when={current().cli !== null} fallback={<CliMissing />}>
            <LoginPanel status={current()} accountID={props.account.id} onStatus={setStatus} />
          </Show>
        )}
      </Show>
      <StatusLine status={problem} />
    </Dialog>
  )
}

/** `Claude Agent 계정 추가` on the section: another login folder, then its login. */
/**
 * The process pool line under the cards (02 §8.10.12): `실행 중인 Claude 3/8`, the conversations waiting for a slot and
 * the ones over the cap for a parked parent's subagent, and `바꾸기` for the cap and the spares (`claudeAgent.pool.set`,
 * admin). The store holds the count: its `claudeAgent.status` read, the setting's answer and `claudeAgent.pool` events.
 */
function PoolLine() {
  const data = useData()
  const text = useClaudeAgentText()
  const own = data.local().own
  const [editing, setEditing] = createSignal(false)
  void own.readClaudeAgentPool().catch(() => undefined)
  const pool = () => own.state.claudeAgentPool
  return (
    <Show when={pool()}>
      {(current) => (
        <div class="mt-1 flex items-center gap-2 text-[12px] text-own-muted" data-testid="claude-agent-pool">
          <span>{text("own.claudeAgent.pool.live", { live: current().live, cap: current().cap })}</span>
          <Show when={current().waiting.length > 0}>
            <span>{text("own.claudeAgent.pool.waiting", { n: current().waiting.length })}</span>
          </Show>
          <Show when={current().over > 0}>
            <span>{text("own.claudeAgent.pool.over", { n: current().over })}</span>
          </Show>
          <Show when={own.rpc.allowed("claudeAgent.pool.set")}>
            <button
              type="button"
              class="own-btn"
              data-size="sm"
              onClick={() => setEditing(true)}
              data-testid="claude-agent-pool-edit"
            >
              {text("own.claudeAgent.pool.edit")}
            </button>
          </Show>
          <Show when={editing()}>
            <PoolDialog pool={current()} onClose={() => setEditing(false)} onSaved={own.setClaudeAgentPool} />
          </Show>
        </div>
      )}
    </Show>
  )
}

function PoolDialog(props: {
  readonly pool: NonNullable<Status["pool"]>
  readonly onClose: () => void
  readonly onSaved: (pool: NonNullable<Status["pool"]>) => void
}) {
  const data = useData()
  const i18n = useI18n()
  const text = useClaudeAgentText()
  const own = data.local().own
  const [processes, setProcesses] = createSignal(props.pool.cap)
  const [spares, setSpares] = createSignal(props.pool.spares)
  const problem = createStatus()
  const save = async () => {
    const saved = await own.rpc
      .call("claudeAgent.pool.set", { processes: processes(), spares: spares() })
      .catch((error: unknown) => {
        problem.error(errorMessage(i18n, error))
        return undefined
      })
    if (!saved) return
    props.onSaved(saved)
    problem.ok(text("own.claudeAgent.pool.saved", { cap: saved.cap }))
    props.onClose()
  }
  const number = (value: string, min: number, max: number, fallback: number) => {
    const parsed = Math.trunc(Number(value))
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback
  }
  return (
    <Dialog
      open
      title={text("own.claudeAgent.pool.title")}
      onClose={() => props.onClose()}
      testid="claude-agent-pool-dialog"
      footer={
        <>
          <button type="button" class="own-btn" onClick={() => props.onClose()}>
            {i18n.t("own.kit.close")}
          </button>
          <button
            type="button"
            class="own-btn"
            data-variant="primary"
            onClick={() => void save()}
            data-testid="claude-agent-pool-save"
          >
            {text("own.claudeAgent.pool.save")}
          </button>
        </>
      }
    >
      <div class="flex flex-col gap-2 text-[13px]">
        <p class="m-0">{text("own.claudeAgent.pool.body")}</p>
        <label class="flex items-center justify-between gap-2">
          <span>{text("own.claudeAgent.pool.processes")}</span>
          <input
            type="number"
            class="own-input w-20"
            min={1}
            max={64}
            value={processes()}
            onInput={(event) => setProcesses(number(event.currentTarget.value, 1, 64, props.pool.cap))}
            data-testid="claude-agent-pool-processes"
          />
        </label>
        <label class="flex items-center justify-between gap-2">
          <span>{text("own.claudeAgent.pool.spares")}</span>
          <input
            type="number"
            class="own-input w-20"
            min={0}
            max={2}
            value={spares()}
            onInput={(event) => setSpares(number(event.currentTarget.value, 0, 2, props.pool.spares))}
            data-testid="claude-agent-pool-spares"
          />
        </label>
      </div>
      <StatusLine status={problem} />
    </Dialog>
  )
}

function AddDialog(props: { readonly onClose: () => void }) {
  const data = useData()
  const i18n = useI18n()
  const text = useClaudeAgentText()
  const own = data.local().own
  const [status, setStatus] = createSignal<Status>()
  const [created, setCreated] = createSignal<string>()
  const problem = createStatus()
  void own.rpc.call("claudeAgent.setup", { add: true }).then(
    (next) => {
      setCreated(next.created)
      setStatus(next)
    },
    (error: unknown) => problem.error(agentFailure(i18n, text, error)),
  )
  return (
    <Dialog
      open
      title={text("own.claudeAgent.add")}
      onClose={() => props.onClose()}
      testid="claude-agent-add-dialog"
      footer={
        <button type="button" class="own-btn" data-variant="primary" onClick={() => props.onClose()}>
          {i18n.t("own.kit.close")}
        </button>
      }
    >
      <div class="flex flex-col gap-2">
        <p class="m-0 text-[13px]">{text("own.claudeAgent.addBody")}</p>
        <Show when={status()}>
          {(current) => (
            <Show when={current().cli !== null} fallback={<CliMissing />}>
              <Show when={created()}>
                {(accountID) => <LoginPanel status={current()} accountID={accountID()} onStatus={setStatus} />}
              </Show>
            </Show>
          )}
        </Show>
      </div>
      <StatusLine status={problem} />
    </Dialog>
  )
}

/**
 * `빼기`: the account goes (its conversations move to the default account), and with `로그인 폴더도 지우기` (on by
 * default) Claude Code's login in its folder too. The shared transcripts stay.
 */
function RemoveDialog(props: {
  readonly account: Account.View
  readonly others: readonly string[]
  readonly onClose: () => void
}) {
  const data = useData()
  const i18n = useI18n()
  const text = useClaudeAgentText()
  const own = data.local().own
  const [folder, setFolder] = createSignal(true)
  const [busy, setBusy] = createSignal(false)
  const status = createStatus()
  const heir = () => {
    const accounts = props.others.flatMap((id) => (own.state.accounts[id] ? [own.state.accounts[id]!] : []))
    return (accounts.find((item) => item.claudeAgent?.default) ?? accounts[0])?.label
  }
  const run = async () => {
    if (busy()) return
    setBusy(true)
    status.clear()
    await own.rpc
      .call("claudeAgent.remove", { accountID: props.account.id, deleteFolder: folder() })
      .then(() => props.onClose())
      .catch((error: unknown) => status.error(agentFailure(i18n, text, error)))
    setBusy(false)
  }
  return (
    <Dialog
      open
      title={text("own.claudeAgent.removeTitle", { account: props.account.label })}
      onClose={() => props.onClose()}
      testid="claude-agent-remove-dialog"
      footer={
        <>
          <button type="button" class="own-btn" onClick={() => props.onClose()}>
            {i18n.t("own.kit.cancel")}
          </button>
          <button
            type="button"
            class="own-btn"
            data-variant="danger"
            disabled={busy()}
            onClick={() => void run()}
            data-testid="claude-agent-remove-confirm"
          >
            {text("own.claudeAgent.remove")}
          </button>
        </>
      }
    >
      <div class="flex flex-col gap-2">
        <p class="m-0">{text("own.claudeAgent.removeBody")}</p>
        <Show when={heir()}>{(label) => <p class="m-0">{text("own.claudeAgent.removeMoves", { account: label() })}</p>}</Show>
        <label class="flex items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            checked={folder()}
            onChange={(event) => setFolder(event.currentTarget.checked)}
            data-testid="claude-agent-remove-folder"
          />
          {claudeAccountsText.text(i18n.locale(), "own.claude.accounts.removeFolder")}
        </label>
        <Show when={folder() && props.account.claudeAgent?.folder}>
          {(path) => (
            <p class="m-0 text-[12px] text-own-muted">
              {text("own.claudeAgent.removeFolderNote")} <span class="own-mono break-all">{path()}</span>
            </p>
          )}
        </Show>
      </div>
      <StatusLine status={status} />
    </Dialog>
  )
}

/**
 * `Claude 로그인 폴더 나누기`: every Claude login folder of this PC with its route; a folder that can move offers the
 * other route (`claudeAgent.folders.assign`), one that cannot says why. One route per folder.
 */
function FoldersPanel() {
  const data = useData()
  const i18n = useI18n()
  const text = useClaudeAgentText()
  const own = data.local().own
  const [folders, setFolders] = createSignal<readonly Folder[]>()
  const [moving, setMoving] = createSignal<string>()
  const status = createStatus()
  const load = () =>
    own.rpc.call("claudeAgent.folders.list", {}).then(
      (listed) => setFolders(listed.folders),
      (error: unknown) => status.error(agentFailure(i18n, text, error)),
    )
  void load()
  const routeName = (route: Folder["route"]) =>
    text(route === "claude-agent" ? "own.claudeAgent.folders.agent" : "own.claudeAgent.folders.auth")
  const move = async (item: Folder) => {
    const route = item.route === "claude-agent" ? "claude-auth" : "claude-agent"
    status.clear()
    setMoving(item.accountID)
    await own.rpc
      .call("claudeAgent.folders.assign", { accountID: item.accountID, route })
      .then(() => status.ok(text("own.claudeAgent.folders.moved", { account: item.label, route: routeName(route) })))
      .catch((error: unknown) => status.error(agentFailure(i18n, text, error)))
    setMoving(undefined)
    await load()
  }
  return (
    <details class="mt-3" data-testid="claude-agent-folders">
      <summary class="cursor-pointer text-[13px] font-semibold">{text("own.claudeAgent.folders")}</summary>
      <p class="m-0 mt-1 text-[12px] text-own-muted">{text("own.claudeAgent.foldersBody")}</p>
      <ul class="m-0 mt-2 flex list-none flex-col gap-1.5 p-0">
        <For each={folders() ?? []}>
          {(item) => (
            <li class="flex flex-wrap items-center gap-2 text-[12.5px]" data-testid="claude-agent-folder-row" data-route={item.route}>
              <Tag tone="soft">{routeName(item.route)}</Tag>
              <span class="font-semibold">{item.label}</span>
              <span class="own-mono min-w-0 break-all text-own-muted">{item.folder}</span>
              <Show
                when={item.movable && own.rpc.allowed("claudeAgent.folders.assign")}
                fallback={
                  <Show when={item.reason}>
                    {(reason) => <span class="text-[12px] text-own-muted">{text(WHY[reason()])}</span>}
                  </Show>
                }
              >
                <button
                  type="button"
                  class="own-btn ml-auto"
                  data-size="sm"
                  disabled={moving() !== undefined}
                  onClick={() => void move(item)}
                  data-testid="claude-agent-folder-move"
                >
                  {text(item.route === "claude-agent" ? "own.claudeAgent.folders.toAuth" : "own.claudeAgent.folders.toAgent")}
                </button>
              </Show>
            </li>
          )}
        </For>
      </ul>
      <StatusLine status={status} testid="claude-agent-folders-status" />
    </details>
  )
}

/** No Claude Code on this PC: own never installs it, so the guide, and `다시 확인` where the caller can check. */
function CliMissing(props: { readonly onRecheck?: () => void }) {
  const host = useHost()
  const text = useClaudeAgentText()
  return (
    <Notice tone="warn" testid="claude-agent-cli-missing">
      {text("own.claudeAgent.cliMissing")}{" "}
      <button
        type="button"
        class="own-link"
        onClick={() => host.openExternal(CLAUDE_CODE_SETUP_URL)}
        data-testid="claude-agent-setup-link"
      >
        {text("own.claudeAgent.setupLink")}
      </button>
      <Show when={props.onRecheck}>
        {(recheck) => (
          <div class="mt-2">
            <button
              type="button"
              class="own-btn"
              data-size="sm"
              onClick={() => recheck()()}
              data-testid="claude-agent-recheck"
            >
              {text("own.claudeAgent.recheck")}
            </button>
          </div>
        )}
      </Show>
    </Notice>
  )
}

/** `로그인 폴더 C:\…\claude-agent\accounts\<id> [복사]`: small, the path selectable and copyable. */
function FolderLine(props: { readonly folder: string }) {
  const text = useClaudeAgentText()
  return (
    <p
      class="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-own-muted"
      data-testid="claude-agent-folder"
    >
      <span>{text("own.claudeAgent.folder")}</span>
      <span class="own-mono min-w-0 break-all select-all">{props.folder}</span>
      <CopyButton value={props.folder} testid="claude-agent-folder-copy" />
    </p>
  )
}

/** The terminal alternative: the command for 명령 프롬프트 and for PowerShell, each in a code box with `복사`. */
function CommandBox(props: { readonly commands: NonNullable<AccountStatus["commands"]> }) {
  const text = useClaudeAgentText()
  const shells = () =>
    [
      { key: "own.claudeAgent.login.cmd", command: props.commands.cmd, id: "cmd" },
      { key: "own.claudeAgent.login.powershell", command: props.commands.powershell, id: "powershell" },
    ] as const
  return (
    <div class="mt-1 flex flex-col gap-1" data-testid="claude-agent-command">
      <span class="text-[12.5px] text-own-muted">{text("own.claudeAgent.login.terminal")}</span>
      <For each={shells()}>
        {(shell) => (
          <div class="flex flex-col gap-0.5" data-shell={shell.id}>
            <span class="text-[12px] text-own-muted">{text(shell.key)}</span>
            <div class="flex items-start gap-2 rounded-lg border border-own-border bg-own-bg p-2">
              <code
                class="own-mono min-w-0 flex-1 break-all select-all text-[12px]"
                data-testid={`claude-agent-command-${shell.id}`}
              >
                {shell.command}
              </code>
              <CopyButton value={shell.command} testid={`claude-agent-command-copy-${shell.id}`} />
            </div>
          </div>
        )}
      </For>
    </div>
  )
}

function CopyButton(props: { readonly value: string; readonly testid: string }) {
  const i18n = useI18n()
  const [copied, setCopied] = createSignal(false)
  return (
    <button
      type="button"
      class="own-btn"
      data-size="sm"
      data-variant="ghost"
      onClick={() => void copyText(props.value).then(setCopied)}
      data-testid={props.testid}
    >
      {i18n.t(copied() ? "own.acct.copied" : "own.acct.copy")}
    </button>
  )
}
