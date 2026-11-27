// ChatGPT login (03 §5.4 "ChatGPT 로그인"): device code by default (port 1455 is Codex CLI's callback port), browser
// as the alternative, and Sign in with ChatGPT (token sharing, a `siwc` account, 02 §3.2c) as the third choice.
// `accounts.add.chatgpt.start → status → complete | cancel`, implemented by the router (01 §8.4); the global active
// credential never changes. Progress arrives as `account.status{attemptID, phase}` events, so the screen asks for
// `status` only when an event, a return to the window or the code's expiry says something changed (no polling timer,
// R9). With `accountID` it is a re-login of that account, with the methods of its kind. Also the Sign in with ChatGPT
// plan pieces other screens show: the one-time "connected" notice and the usage-limit banner.
import type { Account, OwnAccounts } from "@own/protocol"
import { createEffect, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { useData, type ServerKey } from "@/data"
import type { OwnOutput } from "@/data/rpc"
import { useHost } from "@/host"
import { useI18n, type I18nKey } from "@/i18n"
import { resetText, resetTitle } from "@/limits/format"
import { openSwitcher } from "@/limits/intents"
import { ColorPicker, copyText, Notice, Spinner, TextField, createStatus, StatusLine } from "@/limits/kit"
import { minuteNow } from "@/shell/clock"
import { LOGIN_ERRORS, loginMethods, offersConsent, START_ERRORS, USAGE_URL } from "./chatgpt-plan"
import { errorMessage, errorType } from "./errors"
import { COLORS, planLabel } from "./model"

type Start = OwnOutput<"accounts.add.chatgpt.start">
type LoginStatus = OwnOutput<"accounts.add.chatgpt.status">

export interface LoginResult {
  readonly account: Account.View
  readonly reauthenticated: boolean
}

const METHOD_TEXT: Record<OwnAccounts.LoginMethod, { readonly title: I18nKey; readonly note: I18nKey }> = {
  device: { title: "own.chatgpt.device", note: "own.chatgpt.deviceDesc" },
  browser: { title: "own.chatgpt.browser", note: "own.chatgpt.browserNote" },
  siwc: { title: "own.chatgpt.siwc", note: "own.chatgpt.siwcDesc" },
}

export function ChatGPTLogin(props: {
  /** Re-login of an existing codex or siwc account; a siwc account signs in with ChatGPT again, codex never does. */
  readonly accountID?: string
  readonly onDone: (result: LoginResult) => void
  readonly onCancel: () => void
}) {
  const data = useData()
  const host = useHost()
  const i18n = useI18n()
  const own = data.local().own
  const [picked, setPicked] = createSignal<OwnAccounts.LoginMethod>("device")
  const [attempt, setAttempt] = createSignal<Start>()
  const [login, setLogin] = createSignal<LoginStatus>()
  const [label, setLabel] = createSignal("")
  const [color, setColor] = createSignal<Account.Color>("violet")
  const [busy, setBusy] = createSignal(false)
  const [copied, setCopied] = createSignal(false)
  const status = createStatus()
  const target = () => (props.accountID ? own.state.accounts[props.accountID] : undefined)
  const labelOf = (id: string) => own.state.accounts[id]?.label
  const methods = () => loginMethods(target()?.kind)
  // A siwc re-login offers one method: the default pick falls back to it.
  const method = () => (methods().includes(picked()) ? picked() : methods()[0]!)

  /** `consent` only from "동의 후 다시 시도" (`prompt=consent`, 02 §3.2c); ordinary sign-ins never force it. */
  const start = async (consent = false) => {
    if (busy()) return
    setBusy(true)
    status.clear()
    setLogin(undefined)
    // Trying a new Sign in with ChatGPT account again reuses the client ChatGPT issued to the previous attempt.
    const previous = attempt()
    await own.rpc
      .call("accounts.add.chatgpt.start", {
        method: method(),
        ...(props.accountID ? { accountID: props.accountID } : {}),
        ...(consent ? { consent } : {}),
        ...(previous?.method === "siwc" && !props.accountID ? { retryOf: previous.attemptID } : {}),
      })
      .then((next) => {
        setAttempt(next)
        if (next.method !== "device") host.openExternal(next.authorizeURL)
      })
      .catch((error: unknown) => {
        // A refused start is an `internal_error` whose message is the reason.
        const key =
          errorType(error) === "internal_error" && error instanceof Error ? START_ERRORS[error.message] : undefined
        status.error(key ? i18n.t(key) : errorMessage(i18n, error))
      })
    setBusy(false)
  }

  const check = async () => {
    const current = attempt()
    if (!current) return
    const next = await own.rpc
      .call("accounts.add.chatgpt.status", { attemptID: current.attemptID })
      .catch(() => undefined)
    if (!next) return
    setLogin(next)
    if (next.phase === "authorized" && !label()) {
      const plan = next.identity?.plan
      setLabel(target()?.label ?? (plan ? `ChatGPT ${planLabel(plan)}` : "ChatGPT"))
    }
  }

  const complete = async () => {
    const current = attempt()
    if (!current || busy()) return
    setBusy(true)
    status.clear()
    await own.rpc
      .call("accounts.add.chatgpt.complete", {
        attemptID: current.attemptID,
        ...(props.accountID ? {} : { label: label().trim() || "ChatGPT", color: color() }),
      })
      .then((result) => {
        setAttempt(undefined)
        props.onDone(result)
      })
      .catch((error: unknown) => status.error(errorMessage(i18n, error, labelOf)))
    setBusy(false)
  }

  const cancel = () => {
    const current = attempt()
    setAttempt(undefined)
    if (current)
      void own.rpc.call("accounts.add.chatgpt.cancel", { attemptID: current.attemptID }).catch(() => undefined)
    props.onCancel()
  }

  onMount(() => {
    const stopEvents = own.on("account.status", (event) => {
      if (event.data.attemptID && event.data.attemptID === attempt()?.attemptID) void check()
    })
    const visible = () => {
      if (document.visibilityState === "visible" && attempt() && login()?.phase !== "authorized") void check()
    }
    document.addEventListener("visibilitychange", visible)
    window.addEventListener("focus", visible)
    onCleanup(() => {
      stopEvents()
      document.removeEventListener("visibilitychange", visible)
      window.removeEventListener("focus", visible)
      // Leaving the dialog while a login is pending cancels it on the router.
      const current = attempt()
      if (current && login()?.phase !== "authorized")
        void own.rpc.call("accounts.add.chatgpt.cancel", { attemptID: current.attemptID }).catch(() => undefined)
    })
  })

  // One check when the code expires, so an expired attempt does not wait for an event forever (one-shot timer).
  createEffect(() => {
    const at = attempt()?.expiresAt
    if (!at) return
    const timer = setTimeout(() => void check(), Math.max(0, at - Date.now()) + 1_000)
    onCleanup(() => clearTimeout(timer))
  })

  const phase = () => login()?.phase ?? (attempt() ? "pending" : undefined)
  return (
    <div data-testid="chatgpt-login" data-phase={phase() ?? "choose"}>
      <Show when={target() && target()!.connection.method === "codex-linked"}>
        <div class="mb-3">
          <Notice tone="warn">{i18n.t("own.acct.reloginLinked")}</Notice>
        </div>
      </Show>
      <Switch>
        <Match when={!attempt()}>
          <fieldset class="m-0 flex flex-col gap-2 border-0 p-0">
            <legend class="mb-1 text-[13px] font-semibold">{i18n.t("own.acct.loginMethod")}</legend>
            <For each={methods()}>
              {(item) => (
                <label class="flex items-start gap-2">
                  <input
                    type="radio"
                    name="chatgpt-method"
                    class="mt-1"
                    checked={method() === item}
                    onChange={() => setPicked(item)}
                    data-testid={`chatgpt-method-${item}`}
                  />
                  <span>
                    <b class="font-semibold">{i18n.t(METHOD_TEXT[item].title)}</b>
                    <span class="block text-[12.5px] text-own-muted">{i18n.t(METHOD_TEXT[item].note)}</span>
                  </span>
                </label>
              )}
            </For>
          </fieldset>
        </Match>
        <Match when={phase() === "pending" && attempt()?.method === "device" && attempt()}>
          {(current) => {
            const device = () => current() as Extract<Start, { method: "device" }>
            return (
              <div class="flex flex-col items-center gap-3 py-2 text-center" data-testid="chatgpt-device">
                <p class="m-0 text-[13px] text-own-muted">{i18n.t("own.chatgpt.waitingDevice")}</p>
                <code
                  class="own-mono select-all rounded-lg border border-own-border bg-own-subtle px-4 py-2 text-[24px] tracking-[3px]"
                  data-testid="chatgpt-code"
                >
                  {device().userCode}
                </code>
                <div class="flex flex-wrap justify-center gap-2">
                  <button
                    type="button"
                    class="own-btn"
                    data-size="sm"
                    onClick={() => void copyText(device().userCode).then(setCopied)}
                  >
                    {i18n.t(copied() ? "own.acct.copied" : "own.acct.copy")}
                  </button>
                  <button
                    type="button"
                    class="own-btn"
                    data-size="sm"
                    onClick={() => host.openExternal(device().verificationURL)}
                  >
                    {i18n.t("own.acct.openUrl", { url: device().verificationURL })}
                  </button>
                </div>
                <span class="flex items-center gap-2 text-[12.5px] text-own-muted">
                  <Spinner />
                  {i18n.t("own.acct.waiting")}
                </span>
              </div>
            )
          }}
        </Match>
        <Match when={phase() === "pending"}>
          <p class="m-0 flex items-center gap-2 py-4" data-testid="chatgpt-browser">
            <Spinner />
            {i18n.t(attempt()?.method === "siwc" ? "own.chatgpt.waitingSiwc" : "own.chatgpt.waitingBrowser")}
          </p>
        </Match>
        <Match when={phase() === "authorized" && login()?.duplicateOf}>
          {(duplicate) => (
            <Notice tone="warn" testid="chatgpt-duplicate">
              {i18n.t("own.accounts.duplicate", { account: labelOf(duplicate()) ?? duplicate() })}
            </Notice>
          )}
        </Match>
        <Match when={phase() === "authorized"}>
          <div class="flex flex-col gap-3" data-testid="chatgpt-authorized">
            <Notice tone="ok">
              {i18n.t("own.acct.loginVerified", {
                identity: [
                  login()?.identity?.emailMasked,
                  login()?.identity?.plan ? planLabel(login()!.identity!.plan!) : undefined,
                ]
                  .filter(Boolean)
                  .join(" · "),
              })}
            </Notice>
            <Show when={!props.accountID}>
              <TextField
                label={i18n.t("own.acct.name")}
                value={label()}
                onValue={setLabel}
                onEnter={() => void complete()}
              />
              <div class="own-field">
                <span class="own-field-label">{i18n.t("own.acct.color")}</span>
                <ColorPicker value={color()} colors={COLORS} onChange={setColor} />
              </div>
            </Show>
          </div>
        </Match>
        <Match when={login()?.error === "account_mismatch"}>
          <Notice tone="danger" testid="chatgpt-mismatch">
            {i18n.t("own.accounts.wrongIdentity", { account: target()?.label ?? "—" })}
          </Notice>
        </Match>
        <Match when={LOGIN_ERRORS[login()?.error ?? ""]}>
          {(key) => (
            <Notice tone="danger" testid="chatgpt-error">
              <span data-error={login()?.error}>{i18n.t(key())}</span>
              <Show when={offersConsent(attempt()?.method, login()?.error)}>
                <div class="mt-2">
                  <button
                    type="button"
                    class="own-btn"
                    data-size="sm"
                    disabled={busy()}
                    onClick={() => void start(true)}
                    data-testid="chatgpt-consent"
                  >
                    {i18n.t("own.chatgpt.consentRetry")}
                  </button>
                </div>
              </Show>
            </Notice>
          )}
        </Match>
        <Match when={phase() === "failed" || phase() === "cancelled"}>
          <Notice tone="danger">
            {i18n.t(phase() === "failed" ? "own.acct.loginFailed" : "own.acct.loginCancelled")}
          </Notice>
        </Match>
      </Switch>
      <StatusLine status={status} />
      <div class="mt-4 flex justify-end gap-2">
        <button type="button" class="own-btn" onClick={cancel}>
          {i18n.t("own.kit.cancel")}
        </button>
        <Switch>
          <Match when={!attempt() || phase() === "failed" || phase() === "cancelled" || login()?.error}>
            <button
              type="button"
              class="own-btn"
              data-variant="primary"
              disabled={busy()}
              onClick={() => void start()}
              data-testid="chatgpt-start"
            >
              <Show when={busy()}>
                <Spinner />
              </Show>
              {i18n.t(attempt() ? "own.acct.retry" : "own.acct.startLogin")}
            </button>
          </Match>
          <Match when={phase() === "authorized"}>
            <button
              type="button"
              class="own-btn"
              data-variant="primary"
              disabled={busy()}
              onClick={() => void complete()}
              data-testid="chatgpt-complete"
            >
              <Show when={busy()}>
                <Spinner />
              </Show>
              {i18n.t(
                login()?.duplicateOf
                  ? "own.accounts.reauthUpdate"
                  : props.accountID
                    ? "own.acct.updateLogin"
                    : "own.acct.addAccount",
              )}
            </button>
          </Match>
        </Switch>
      </div>
    </div>
  )
}

/**
 * The one-time "ChatGPT 요금제로 연결됨" notice after the first new Sign in with ChatGPT account (OpenAI's UI guideline:
 * once, with a "Manage usage" link). The add dialog's done step shows it when `firstPlanLogin()` says so.
 */
export function PlanWelcome() {
  const i18n = useI18n()
  return (
    <Notice tone="ok" testid="chatgpt-welcome">
      <p class="m-0 font-semibold">{i18n.t("own.chatgpt.welcomeTitle")}</p>
      <p class="m-0 mt-0.5">{i18n.t("own.chatgpt.welcomeBody")}</p>
      <ManageUsage />
    </Notice>
  )
}

/** "사용량 관리": ChatGPT Settings → Usage in the system browser. */
export function ManageUsage() {
  const host = useHost()
  const i18n = useI18n()
  return (
    <button type="button" class="own-link" onClick={() => host.openExternal(USAGE_URL)} data-testid="chatgpt-usage">
      {i18n.t("own.chatgpt.manageUsage")}
    </button>
  )
}

/**
 * Session banner of a Sign in with ChatGPT account at its usage limit (02 §3.2c `usage_limit_exceeded`, recognized by
 * code): manage usage first, or switch. It names a reset only when the 429 itself said one (the account's
 * `siwc.usage` window); otherwise none is promised, since an app-specific cap may apply.
 */
export function UsageLimitBanner(props: {
  readonly accountID: string
  readonly serverKey?: ServerKey
  readonly sessionID?: string
}) {
  const data = useData()
  const host = useHost()
  const i18n = useI18n()
  const reset = () => {
    const resetAt = data.local().own.state.quota[props.accountID]?.find((window) => window.id === "siwc.usage")?.resetAt
    return resetAt !== undefined && resetAt > minuteNow() ? resetAt : undefined
  }
  return (
    <div class="own-notice" data-tone="danger" role="alert" data-testid="chatgpt-usage-limit">
      <span class="font-extrabold" aria-hidden="true">
        !
      </span>
      <div class="min-w-0 flex-1">
        <p class="m-0 font-semibold">{i18n.t("own.chatgpt.usageLimit")}</p>
        <p class="m-0 mt-0.5 text-own-muted">{i18n.t("own.chatgpt.usageLimitHelp")}</p>
        <Show when={reset()}>
          {(at) => (
            <p class="m-0 mt-0.5 text-own-muted" title={resetTitle(i18n, at())} data-testid="chatgpt-usage-limit-reset">
              {i18n.t("own.chatgpt.usageLimitReset", { reset: resetText(i18n, minuteNow(), at()) })}
            </p>
          )}
        </Show>
        <div class="mt-2 flex flex-wrap gap-1.5">
          <button
            type="button"
            class="own-btn"
            data-size="sm"
            data-variant="primary"
            onClick={() => host.openExternal(USAGE_URL)}
            data-testid="chatgpt-usage-limit-manage"
          >
            {i18n.t("own.chatgpt.manageUsage")}
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
