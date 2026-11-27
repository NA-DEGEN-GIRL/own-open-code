// Account card dialogs (03 §5.4 `⋯` menu): rename, budget, key replacement and removal. Removal is two-step (plan →
// nonce → execute, 01 §13): the plan lists the sessions using the account, a mode change plans again, an expired
// nonce plans again. Secrets (a replacement key) leave the form state as soon as they are sent (16.3).
import type { Account } from "@own/protocol"
import { createEffect, createSignal, on, Show } from "solid-js"
import { useData } from "@/data"
import type { OwnOutput } from "@/data/rpc"
import { useI18n } from "@/i18n"
import { Dialog, Notice, Spinner, TextField, createStatus, StatusLine } from "@/limits/kit"
import { SessionList } from "./claude-slot"
import { errorMessage, errorType } from "./errors"
import { legacyKeyText } from "./legacy-key-strings"

export function RenameDialog(props: { readonly account: Account.View | undefined; readonly onClose: () => void }) {
  return <Show when={props.account}>{(account) => <RenameForm account={account()} onClose={props.onClose} />}</Show>
}

function RenameForm(props: { readonly account: Account.View; readonly onClose: () => void }) {
  const data = useData()
  const i18n = useI18n()
  const [label, setLabel] = createSignal(props.account.label)
  const [busy, setBusy] = createSignal(false)
  const status = createStatus()
  const save = async () => {
    const next = label().trim()
    if (!next || busy()) return
    setBusy(true)
    await data
      .local()
      .own.rpc.call("accounts.update", { accountID: props.account.id, label: next })
      .then(() => props.onClose())
      .catch((error: unknown) => status.error(errorMessage(i18n, error)))
    setBusy(false)
  }
  return (
    <Dialog
      open
      title={i18n.t("own.acct.renameTitle")}
      onClose={props.onClose}
      testid="rename-dialog"
      footer={
        <>
          <button type="button" class="own-btn" onClick={() => props.onClose()}>
            {i18n.t("own.kit.cancel")}
          </button>
          <button
            type="button"
            class="own-btn"
            data-variant="primary"
            disabled={!label().trim() || busy()}
            onClick={() => void save()}
          >
            {i18n.t("own.kit.save")}
          </button>
        </>
      }
    >
      <TextField
        label={i18n.t("own.acct.name")}
        value={label()}
        onValue={setLabel}
        onEnter={() => void save()}
        autofocus
        maxLength={80}
        testid="rename-input"
      />
      <StatusLine status={status} />
    </Dialog>
  )
}

/** Monthly budget of a metered account (7.1 `이번 달 지출 / 예산`, the budget is user input). */
export function BudgetDialog(props: { readonly account: Account.View | undefined; readonly onClose: () => void }) {
  return <Show when={props.account}>{(account) => <BudgetForm account={account()} onClose={props.onClose} />}</Show>
}

function BudgetForm(props: { readonly account: Account.View; readonly onClose: () => void }) {
  const data = useData()
  const i18n = useI18n()
  const [value, setValue] = createSignal(props.account.budget ? String(props.account.budget.monthlyUSD) : "")
  const [busy, setBusy] = createSignal(false)
  const status = createStatus()
  const parsed = () => {
    const text = value().replaceAll(/[,$\s]/g, "")
    if (!text) return null
    const number = Number(text)
    return Number.isFinite(number) && number >= 0 ? number : undefined
  }
  const save = async () => {
    const budget = parsed()
    if (budget === undefined || busy()) return
    setBusy(true)
    await data
      .local()
      .own.rpc.call("accounts.update", {
        accountID: props.account.id,
        budget: budget === null || budget === 0 ? null : { monthlyUSD: budget },
      })
      .then(() => props.onClose())
      .catch((error: unknown) => status.error(errorMessage(i18n, error)))
    setBusy(false)
  }
  return (
    <Dialog
      open
      title={i18n.t("own.acct.budgetTitle", { account: props.account.label })}
      onClose={props.onClose}
      footer={
        <>
          <button type="button" class="own-btn" onClick={() => props.onClose()}>
            {i18n.t("own.kit.cancel")}
          </button>
          <button
            type="button"
            class="own-btn"
            data-variant="primary"
            disabled={parsed() === undefined || busy()}
            onClick={() => void save()}
          >
            {i18n.t("own.kit.save")}
          </button>
        </>
      }
    >
      <TextField
        label={i18n.t("own.acct.budgetField")}
        value={value()}
        onValue={setValue}
        onEnter={() => void save()}
        inputMode="decimal"
        autofocus
        error={parsed() === undefined ? i18n.t("own.lim.numberNeeded") : undefined}
        hint={i18n.t("own.acct.budgetHint")}
      />
      <StatusLine status={status} />
    </Dialog>
  )
}

/** `키 교체` (API key accounts): `accounts.update{replaceKey}`; the router tests the new key before storing it. */
export function ReplaceKeyDialog(props: { readonly account: Account.View | undefined; readonly onClose: () => void }) {
  return <Show when={props.account}>{(account) => <ReplaceKeyForm account={account()} onClose={props.onClose} />}</Show>
}

function ReplaceKeyForm(props: { readonly account: Account.View; readonly onClose: () => void }) {
  const data = useData()
  const i18n = useI18n()
  const [key, setKey] = createSignal("")
  const [shown, setShown] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const status = createStatus()
  const save = async () => {
    const secret = key().trim()
    if (!secret || busy()) return
    setBusy(true)
    status.clear()
    // 16.3: the key leaves the form state as soon as it is on its way.
    setKey("")
    await data
      .local()
      .own.rpc.call("accounts.update", { accountID: props.account.id, replaceKey: secret })
      .then(() => props.onClose())
      .catch((error: unknown) => status.error(errorMessage(i18n, error)))
    setBusy(false)
  }
  return (
    <Dialog
      open
      title={i18n.t("own.acct.replaceKeyTitle", { account: props.account.label })}
      onClose={props.onClose}
      testid="replace-key-dialog"
      footer={
        <>
          <button type="button" class="own-btn" onClick={() => props.onClose()}>
            {i18n.t("own.kit.cancel")}
          </button>
          <button
            type="button"
            class="own-btn"
            data-variant="primary"
            disabled={!key().trim() || busy()}
            onClick={() => void save()}
          >
            <Show when={busy()}>
              <Spinner />
            </Show>
            {i18n.t("own.acct.testAndSave")}
          </button>
        </>
      }
    >
      <div class="flex items-end gap-2">
        <div class="min-w-0 flex-1">
          <TextField
            label={i18n.t("own.acct.apiKey")}
            type={shown() ? "text" : "password"}
            value={key()}
            onValue={setKey}
            onEnter={() => void save()}
            autocomplete="off"
            spellcheck={false}
            autofocus
            class="own-mono"
          />
        </div>
        <button type="button" class="own-btn" aria-pressed={shown()} onClick={() => setShown((value) => !value)}>
          {i18n.t(shown() ? "own.acct.hide" : "own.acct.show")}
        </button>
      </div>
      <p class="m-0 mt-2 text-[12px] text-own-muted">{i18n.t("own.accounts.keyStorage")}</p>
      <StatusLine status={status} />
    </Dialog>
  )
}

/** 5.4 `제거 확인`: `accounts.remove.plan{accountID, mode}` → confirm → `accounts.remove.execute{nonce}`. */
export function RemoveDialog(props: { readonly account: Account.View | undefined; readonly onClose: () => void }) {
  return <Show when={props.account}>{(account) => <RemoveForm account={account()} onClose={props.onClose} />}</Show>
}

function RemoveForm(props: { readonly account: Account.View; readonly onClose: () => void }) {
  const data = useData()
  const i18n = useI18n()
  const own = data.local().own
  const [mode, setMode] = createSignal<"delete" | "disable">("delete")
  const [plan, setPlan] = createSignal<OwnOutput<"accounts.remove.plan">>()
  const [busy, setBusy] = createSignal(false)
  const status = createStatus()
  const load = async () => {
    setPlan(undefined)
    await own.rpc
      .call("accounts.remove.plan", { accountID: props.account.id, mode: mode() })
      .then((next) => void setPlan(next))
      .catch((error: unknown) => status.error(errorMessage(i18n, error)))
  }
  createEffect(on(mode, () => void load()))
  const run = async () => {
    const current = plan()
    if (!current || busy()) return
    setBusy(true)
    status.clear()
    await own.rpc
      .call("accounts.remove.execute", { nonce: current.nonce })
      .then(() => props.onClose())
      .catch(async (error: unknown) => {
        if (errorType(error) !== "nonce_invalid") return status.error(errorMessage(i18n, error))
        status.info(i18n.t("own.acct.err.nonce"))
        await load()
      })
    setBusy(false)
  }
  const linked = () => props.account.connection.method === "codex-linked"
  return (
    <Dialog
      open
      title={i18n.t("own.acct.removeTitle", { account: props.account.label })}
      onClose={props.onClose}
      testid="remove-dialog"
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
            data-testid="remove-execute"
          >
            <Show when={busy()}>
              <Spinner />
            </Show>
            {i18n.t(mode() === "delete" ? "own.acct.removeRun" : "own.acct.disableRun")}
          </button>
        </>
      }
    >
      <fieldset class="m-0 flex flex-col gap-1.5 border-0 p-0">
        <legend class="sr-only">{i18n.t("own.acct.removeTitle", { account: props.account.label })}</legend>
        <label class="flex items-center gap-2">
          <input type="radio" name="remove-mode" checked={mode() === "delete"} onChange={() => setMode("delete")} />
          {i18n.t("own.accounts.removeDelete")}
        </label>
        <label class="flex items-center gap-2">
          <input
            type="radio"
            name="remove-mode"
            checked={mode() === "disable"}
            onChange={() => setMode("disable")}
            data-testid="remove-disable"
          />
          {i18n.t("own.accounts.removeDisable")}
        </label>
      </fieldset>
      <Show when={plan()} fallback={<p class="own-placeholder px-0">{i18n.t("own.shell.loading")}</p>}>
        {(current) => (
          <div class="mt-3 flex flex-col gap-2" data-testid="remove-plan">
            <Show
              when={current().affectedSessions.length}
              fallback={<p class="m-0 text-own-muted">{i18n.t("own.acct.removeNoSessions")}</p>}
            >
              <Notice tone="warn">
                {i18n.t("own.accounts.removeConfirm", { n: current().affectedSessions.length })}
                <SessionList ids={current().affectedSessions} />
              </Notice>
            </Show>
            <Show when={linked()}>
              <p class="m-0 text-[12.5px] text-own-muted">{i18n.t("own.codex.removeKeepsSource")}</p>
            </Show>
            <Show when={props.account.connection.legacyKey}>
              <p class="m-0 text-[12.5px] text-own-muted" data-testid="remove-keeps-legacy-key">
                {legacyKeyText.text(i18n.locale(), "own.legacyKey.removeKeepsSource")}
              </p>
            </Show>
            <Show when={mode() === "delete" && current().willShredVault}>
              <p class="m-0 text-[12.5px] text-own-muted">{i18n.t("own.acct.removeShred")}</p>
            </Show>
            <Show when={mode() === "delete" && props.account.kind === "siwc"}>
              <p class="m-0 text-[12.5px] text-own-muted" data-testid="remove-siwc-revoke">
                {i18n.t("own.chatgpt.removeRevoke")}
              </p>
            </Show>
            <Show when={mode() === "disable"}>
              <p class="m-0 text-[12.5px] text-own-muted">{i18n.t("own.acct.disableNote")}</p>
            </Show>
          </div>
        )}
      </Show>
      <StatusLine status={status} />
    </Dialog>
  )
}
