// The 리셋권 쓰기 dialog (03 §7.1.1, 02 §7.1.1), lazy: it lists the account's reset credits (`quota.resetCredits.list`),
// plans the picked one (`redeem.plan`: a nonce and the request id ChatGPT redeems once), and asks
// `이 리셋권을 쓸까요?` with the account, the credit, its expiry and the limits now, 취소 focused, before
// `redeem.execute`. No answer keeps the nonce: `다시 시도` sends the same request, so a credit is never spent twice.
import type { Limit } from "@own/protocol"
import { createSignal, For, Match, onMount, Show, Switch } from "solid-js"
import { errorData, errorType } from "@/accounts/errors"
import { useData } from "@/data"
import type { OwnOutput } from "@/data/rpc"
import { useI18n } from "@/i18n"
import { minuteNow } from "@/shell/clock"
import { clock } from "./format"
import { Dialog, Spinner } from "./kit"
import {
  belowLimit,
  day,
  expiryOf,
  failure,
  loginKey,
  notSentKey,
  options,
  outcomeKey,
  outcomeUnknown,
  planWindows,
  type CreditOption,
} from "./reset-credits-model"
import { useResetCreditText, type ResetCreditKey } from "./reset-credits-strings"
import { LimitSummaryLine } from "./summary-line"
import "./reset-credits.css"

type Plan = OwnOutput<"quota.resetCredits.redeem.plan">

type Step =
  | { readonly name: "loading" }
  | { readonly name: "pick"; readonly credits: Limit.ResetCredits }
  | { readonly name: "confirm"; readonly option: CreditOption; readonly plan: Plan }
  | { readonly name: "running"; readonly option: CreditOption; readonly plan: Plan }
  | { readonly name: "failed"; readonly option: CreditOption; readonly plan: Plan; readonly status?: number }
  /** A result or a problem, and what may follow (`again`: list again, labelled so). */
  | {
      readonly name: "message"
      readonly key: ResetCreditKey
      readonly n?: number
      readonly tone: "ok" | "warn"
      readonly again?: ResetCreditKey
    }

type StepOf<N extends Step["name"]> = Extract<Step, { readonly name: N }>

export default function ResetCreditDialog(props: { readonly accountID: string; readonly onClose: () => void }) {
  const data = useData()
  const i18n = useI18n()
  const t = useResetCreditText()
  const own = data.local().own
  const [step, setStep] = createSignal<Step>({ name: "loading" })
  const [busy, setBusy] = createSignal(false)
  /** The current step when it is one of `names`, for `<Match>`. */
  const at =
    <N extends Step["name"]>(...names: N[]) =>
    () => {
      const current = step()
      return (names as Step["name"][]).includes(current.name) ? (current as StepOf<N>) : undefined
    }

  const problem = (error: unknown): Step => {
    const type = errorType(error)
    if (type === "credential_not_ready")
      return { name: "message", key: loginKey(errorData<{ cause: string }>(error).cause), tone: "warn" }
    if (type === "nonce_invalid")
      return { name: "message", key: "own.rc.expired", tone: "warn", again: "own.rc.restart" }
    return { name: "message", key: "own.rc.loadFailed", tone: "warn", again: "own.rc.retry" }
  }

  const load = async () => {
    setStep({ name: "loading" })
    await own.rpc
      .call("quota.resetCredits.list", { accountID: props.accountID })
      .then((output) => {
        own.setResetCredits(output.resetCredits)
        setStep(
          output.resetCredits.availableCount > 0
            ? { name: "pick", credits: output.resetCredits }
            : { name: "message", key: "own.rc.noCredit", tone: "warn" },
        )
      })
      .catch((error: unknown) => setStep(problem(error)))
  }
  onMount(() => void load())

  const choose = async (option: CreditOption) => {
    if (busy()) return
    setBusy(true)
    await own.rpc
      .call("quota.resetCredits.redeem.plan", {
        accountID: props.accountID,
        ...(option.creditID === undefined ? {} : { creditID: option.creditID }),
      })
      .then((plan) => setStep({ name: "confirm", option, plan }))
      .catch((error: unknown) => setStep(problem(error)))
    setBusy(false)
  }

  const redeem = async (option: CreditOption, plan: Plan) => {
    setStep({ name: "running", option, plan })
    await own.rpc
      .call("quota.resetCredits.redeem.execute", { nonce: plan.nonce })
      .then((result) => {
        const redeemed = result.outcome === "reset" || result.outcome === "already_redeemed"
        if (result.resetCredits) own.setResetCredits(result.resetCredits)
        // Redeemed, and the read after it named no count: unknown now, not the count from before (as Codex).
        if (redeemed && !result.resetCredits) own.forgetResetCredits(props.accountID)
        if (result.windows) own.setWindows(props.accountID, result.windows)
        const picked = option.creditID !== undefined
        setStep({
          name: "message",
          key: outcomeKey(result.outcome, picked, result.resetCredits !== undefined),
          n: result.resetCredits?.availableCount,
          tone: redeemed ? "ok" : "warn",
          ...(result.outcome === "no_credit" && picked ? { again: "own.rc.refresh" as const } : {}),
        })
      })
      .catch((error: unknown) => {
        // No answer or an error answer keeps the nonce: the retry sends the same request id.
        if (errorType(error) === "limit_reset_failed")
          return setStep({ name: "failed", option, plan, status: errorData<{ status: number }>(error).status })
        // Refused before anything was sent: the credit is unused, and listing again would not change that.
        const unsent = notSentKey(errorType(error))
        if (unsent) return setStep({ name: "message", key: unsent, tone: "warn" })
        // Whether the credit went is not known: list again (the service reads ChatGPT anew) rather than guess.
        if (outcomeUnknown(errorType(error)))
          return setStep({ name: "message", key: "own.rc.unknownResult", tone: "warn", again: "own.rc.recheck" })
        setStep(problem(error))
      })
  }

  const expiry = (expiresAt: ReturnType<typeof expiryOf>) => {
    if (expiresAt === "unknown") return t("own.rc.expiryUnknown")
    if (expiresAt === "never") return t("own.rc.noExpiry")
    return t("own.rc.until", { when: `${day(i18n.locale(), expiresAt)} ${clock(i18n, expiresAt)}` })
  }

  return (
    <Dialog
      open
      title={t("own.rc.title", { account: own.state.accounts[props.accountID]?.label ?? "" })}
      // A redeem on its way finishes first; its result is what the user needs to see.
      onClose={() => step().name !== "running" && props.onClose()}
      testid="reset-credit-dialog"
      footer={
        <Switch>
          <Match when={at("confirm")()}>
            {(current) => (
              <>
                <button
                  type="button"
                  class="own-btn"
                  ref={(element) => queueMicrotask(() => element.focus())}
                  onClick={() => props.onClose()}
                  data-testid="reset-credit-cancel"
                >
                  {t("own.rc.cancel")}
                </button>
                <button
                  type="button"
                  class="own-btn"
                  data-variant="danger"
                  onClick={() => void redeem(current().option, current().plan)}
                  data-testid="reset-credit-confirm"
                >
                  {t("own.rc.use")}
                </button>
              </>
            )}
          </Match>
          <Match when={at("failed")()}>
            {(current) => (
              <>
                <button type="button" class="own-btn" onClick={() => props.onClose()} data-testid="reset-credit-close">
                  {t("own.rc.close")}
                </button>
                <Show when={failure(current().status).retry}>
                  <button
                    type="button"
                    class="own-btn"
                    data-variant="primary"
                    onClick={() => void redeem(current().option, current().plan)}
                    data-testid="reset-credit-retry"
                  >
                    {t("own.rc.retry")}
                  </button>
                </Show>
              </>
            )}
          </Match>
          <Match when={at("running")()}>
            <button type="button" class="own-btn" disabled>
              <Spinner />
              {t("own.rc.running")}
            </button>
          </Match>
          <Match when={true}>
            <Show when={at("message")()?.again}>
              {(again) => (
                <button type="button" class="own-btn" onClick={() => void load()} data-testid="reset-credit-again">
                  {t(again())}
                </button>
              )}
            </Show>
            <Show when={at("pick")()}>
              <button type="button" class="own-btn" onClick={() => void load()} data-testid="reset-credit-refresh">
                {t("own.rc.refresh")}
              </button>
            </Show>
            <button type="button" class="own-btn" onClick={() => props.onClose()} data-testid="reset-credit-close">
              {t("own.rc.close")}
            </button>
          </Match>
        </Switch>
      }
    >
      <div data-testid="reset-credit-step" data-step={step().name}>
        <Switch>
          <Match when={at("loading")()}>
            <p class="m-0 flex items-center gap-2 text-own-muted">
              <Spinner />
              {t("own.rc.loading")}
            </p>
          </Match>
          <Match when={at("pick")()}>
            {(current) => (
              <div class="flex flex-col gap-2">
                <p class="m-0 text-own-muted">{t("own.rc.pick")}</p>
                <For each={options(current().credits)}>
                  {(option) => (
                    <button
                      type="button"
                      class="own-rc-option"
                      disabled={busy()}
                      onClick={() => void choose(option)}
                      data-testid="reset-credit-option"
                      data-credit-id={option.creditID}
                    >
                      <span class="font-semibold">{option.title ?? t("own.rc.fullReset")}</span>
                      <span class="text-[12px] text-own-muted">{option.description ?? t("own.rc.fullResetNote")}</span>
                      <span class="text-[12px] text-own-faint" data-testid="reset-credit-option-expiry">
                        {expiry(expiryOf(option))}
                      </span>
                    </button>
                  )}
                </For>
              </div>
            )}
          </Match>
          <Match when={at("confirm", "running", "failed")()}>
            {(current) => (
              <div class="flex flex-col gap-2">
                <p class="m-0 font-semibold" data-testid="reset-credit-question">
                  {t("own.rc.confirm")}
                </p>
                <dl class="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]" data-testid="reset-credit-facts">
                  <dt class="text-own-muted">{t("own.rc.account")}</dt>
                  <dd class="m-0">{current().plan.account.label}</dd>
                  <dt class="text-own-muted">{t("own.rc.credit")}</dt>
                  <dd class="m-0">{current().plan.credit?.title ?? current().option.title ?? t("own.rc.fullReset")}</dd>
                  <dt class="text-own-muted">{t("own.rc.expiry")}</dt>
                  <dd class="m-0" data-testid="reset-credit-expiry">
                    {expiry(expiryOf(current().option, current().plan.credit?.expiresAt ?? current().option.expiresAt))}
                  </dd>
                  <dt class="text-own-muted">{t("own.rc.windows")}</dt>
                  <dd class="m-0" data-testid="reset-credit-windows">
                    <Show
                      when={planWindows(current().plan.windows).length > 0}
                      fallback={<span class="text-own-muted">{t("own.rc.windowsUnknown")}</span>}
                    >
                      <LimitSummaryLine windows={planWindows(current().plan.windows)} now={minuteNow} max={3} />
                    </Show>
                  </dd>
                </dl>
                <p class="m-0 text-own-warn" data-testid="reset-credit-irreversible">
                  {t("own.rc.irreversible")}
                </p>
                <Show when={belowLimit(current().plan.windows)}>
                  <p class="m-0 text-own-warn" data-testid="reset-credit-below-limit">
                    {t("own.rc.belowLimit")}
                  </p>
                </Show>
                <Show when={current().name === "running"}>
                  <p
                    class="m-0 flex items-center gap-2 text-own-muted"
                    role="status"
                    data-testid="reset-credit-running"
                  >
                    <Spinner />
                    {t("own.rc.running")}
                  </p>
                </Show>
                <Show when={at("failed")()}>
                  {(failed) => (
                    <div class="own-notice" data-tone="danger" role="alert" data-testid="reset-credit-failed">
                      <div class="min-w-0 flex-1">
                        <p class="m-0 font-semibold">{t("own.rc.failed")}</p>
                        <p class="m-0 mt-0.5 text-own-muted">
                          {t(failure(failed().status).key, { status: failed().status ?? "" })}
                        </p>
                      </div>
                    </div>
                  )}
                </Show>
              </div>
            )}
          </Match>
          <Match when={at("message")()}>
            {(current) => (
              <p
                class="m-0"
                classList={{ "text-own-warn": current().tone === "warn" }}
                role="status"
                data-testid="reset-credit-result"
                data-tone={current().tone}
              >
                {t(current().key, { n: current().n ?? 0 })}
              </p>
            )}
          </Match>
        </Switch>
      </div>
    </Dialog>
  )
}
