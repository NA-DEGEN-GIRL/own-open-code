// ChatGPT usage-limit reset credits on screen (03 §7.1.1 리셋권, 02 §7.1.1): the line under a ChatGPT subscription
// card's limits summary (the 계정 page and the `/limits` cards), the switcher row's count, the banner of a conversation
// whose ChatGPT or Claude account is out of its limit, and Claude's link-only note. `리셋권 쓰기` only opens the dialog
// (./reset-credits-dialog, lazy); nothing redeems without its confirmation. Redeeming is this PC's windows' alone
// (`local` scope, 02 §9.1): a phone or another PC sees the count and `리셋권은 이 PC 화면에서만 쓸 수 있어요`.
// Sign in with ChatGPT accounts show nothing (02 §7.1). Lazy, with the summary.
import type { Account } from "@own/protocol"
import { createSignal, lazy, Match, Show, Suspense, Switch } from "solid-js"
import type { ServerKey } from "@/data"
import { useData } from "@/data"
import { useHost } from "@/host"
import { useI18n } from "@/i18n"
import { minuteNow } from "@/shell/clock"
import { ago, clock } from "./format"
import { openSwitcher } from "./intents"
import { day, lineState, soonest } from "./reset-credits-model"
import { useResetCreditText } from "./reset-credits-strings"

const ResetCreditDialog = lazy(() => import("./reset-credits-dialog"))

/** Where Claude's own reset credits are shown and used (02 §8.5): own neither reads nor redeems them. */
export const CLAUDE_USAGE_URL = "https://claude.ai/settings/usage"

/**
 * The line under a ChatGPT subscription account's limits: `리셋권 2개 · 11월 3일 오후 5:00까지 · 3분 전 확인` and
 * `리셋권 쓰기` once a count is known and above 0. Unfolded only: `리셋권 없음` at 0, and `리셋권 확인` while no count
 * is known (it asks ChatGPT, `quota.resetCredits.list`).
 */
export function ResetCreditLine(props: { readonly accountID: string; readonly expanded: boolean }) {
  const data = useData()
  const i18n = useI18n()
  const t = useResetCreditText()
  const own = data.local().own
  const credits = () => own.state.resetCredits[props.accountID]
  const state = () => {
    const shown = lineState(credits(), props.expanded)
    return shown === "check" && !own.rpc.allowed("quota.resetCredits.list") ? "hidden" : shown
  }
  const [dialog, setDialog] = createSignal(false)
  const [checking, setChecking] = createSignal(false)
  const [failed, setFailed] = createSignal(false)
  const check = async () => {
    setChecking(true)
    setFailed(false)
    await own.rpc
      .call("quota.resetCredits.list", { accountID: props.accountID })
      .then((output) => own.setResetCredits(output.resetCredits))
      .catch(() => setFailed(true))
    setChecking(false)
  }
  const observed = () => {
    const item = credits()
    return item ? t("own.rc.observed", { ago: ago(i18n, minuteNow(), item.observedAt) }) : ""
  }
  const expiry = () => {
    const at = soonest(credits())
    return at === undefined ? undefined : t("own.rc.until", { when: `${day(i18n.locale(), at)} ${clock(i18n, at)}` })
  }
  return (
    <>
      <Show when={state() !== "hidden"}>
        <div
          class="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12.5px] leading-[18px]"
          data-testid="reset-credits"
          data-state={state()}
        >
          <Switch>
            <Match when={state() === "count"}>
              <span class="font-semibold" data-testid="reset-credits-count">
                {t("own.rc.count", { n: credits()?.availableCount ?? 0 })}
              </span>
              <Show when={expiry()}>{(text) => <span data-testid="reset-credits-expiry">· {text()}</span>}</Show>
              <span class="text-own-faint">· {observed()}</span>
              <Show
                when={own.rpc.allowed("quota.resetCredits.redeem.plan")}
                fallback={<span class="w-full text-own-faint">{t("own.rc.thisPcOnly")}</span>}
              >
                <button
                  type="button"
                  class="own-link"
                  aria-haspopup="dialog"
                  onClick={() => setDialog(true)}
                  data-testid="reset-credits-use"
                >
                  {t("own.rc.use")}
                </button>
              </Show>
            </Match>
            <Match when={state() === "none"}>
              <span data-testid="reset-credits-count">{t("own.rc.none")}</span>
              <span class="text-own-faint">· {observed()}</span>
            </Match>
            <Match when={state() === "check"}>
              <button
                type="button"
                class="own-link"
                disabled={checking()}
                onClick={() => void check()}
                data-testid="reset-credits-check"
              >
                {t(checking() ? "own.rc.checking" : "own.rc.check")}
              </button>
              <Show when={failed()}>
                <span class="text-own-warn" role="status">
                  {t("own.rc.checkFailed")}
                </span>
              </Show>
            </Match>
          </Switch>
        </div>
      </Show>
      {/* Beside the line, not in it: using the last credit of a folded card hides the line, never the result. */}
      <Show when={dialog()}>
        <Suspense>
          <ResetCreditDialog accountID={props.accountID} onClose={() => setDialog(false)} />
        </Suspense>
      </Show>
    </>
  )
}

/** The switcher row's `· 리셋권 2개` after its limits line (an option holds no button, so no `리셋권 쓰기` there). */
export function ResetCreditCount(props: { readonly account: Account.View }) {
  const data = useData()
  const t = useResetCreditText()
  const count = () =>
    props.account.kind === "codex" ? (data.local().own.state.resetCredits[props.account.id]?.availableCount ?? 0) : 0
  return (
    <Show when={count() > 0}>
      <span class="own-lsum-sep">·</span>
      <span class="own-lsum-part" data-role="reset-credits" data-testid="switcher-reset-credits">
        {t("own.rc.count", { n: count() })}
      </span>
    </Show>
  )
}

/** Claude's resets are claude.ai's (02 §8.5): a muted line that links there, never a count. */
export function ClaudeResetNote() {
  const host = useHost()
  const t = useResetCreditText()
  return (
    <p class="m-0 mt-1.5 text-[12px] leading-[18px] text-own-muted" data-testid="claude-reset-note">
      <button
        type="button"
        class="own-link text-left"
        onClick={() => host.openExternal(CLAUDE_USAGE_URL)}
        data-testid="claude-reset-link"
      >
        {t("own.rc.claude")}
      </button>
    </p>
  )
}

/**
 * The banner of a conversation whose account used its limit up (03 §6.6, §7.1.1): a ChatGPT subscription account with
 * reset credits gets `리셋권 쓰기` (it opens the dialog), a Claude account the note; both `다른 계정으로 전환…`.
 */
export function LimitReachedBanner(props: {
  readonly accountID: string
  readonly serverKey: ServerKey
  readonly sessionID: string
  /** The dialog opened or closed: the conversation keeps the banner (and so the dialog) until it closes. */
  readonly onDialog: (open: boolean) => void
}) {
  const data = useData()
  const t = useResetCreditText()
  const own = data.local().own
  const account = () => own.state.accounts[props.accountID]
  const count = () => own.state.resetCredits[props.accountID]?.availableCount ?? 0
  const [dialog, setDialog] = createSignal(false)
  const toggle = (open: boolean) => {
    setDialog(open)
    props.onDialog(open)
  }
  return (
    <Show when={account()}>
      {(item) => (
        <div
          class="own-notice"
          data-tone="warn"
          role="alert"
          data-testid="limit-reached-banner"
          data-kind={item().kind}
        >
          <span class="font-extrabold" aria-hidden="true">
            !
          </span>
          <div class="min-w-0 flex-1">
            <p class="m-0 font-semibold">{t("own.rc.bannerTitle", { account: item().label })}</p>
            {/* A codex banner held open by its dialog after the last credit was used names no count and offers none. */}
            <Show when={item().kind === "codex"} fallback={<ClaudeResetNote />}>
              <Show when={count() > 0}>
                <p class="m-0 mt-0.5 text-own-muted" data-testid="limit-reached-credits">
                  {t("own.rc.bannerCount", { n: count() })}
                </p>
              </Show>
            </Show>
            <div class="mt-2 flex flex-wrap items-center gap-1.5">
              <Show when={item().kind === "codex" && count() > 0}>
                <Show
                  when={own.rpc.allowed("quota.resetCredits.redeem.plan")}
                  fallback={<span class="text-[12px] text-own-faint">{t("own.rc.thisPcOnly")}</span>}
                >
                  <button
                    type="button"
                    class="own-btn"
                    data-size="sm"
                    data-variant="primary"
                    aria-haspopup="dialog"
                    onClick={() => toggle(true)}
                    data-testid="limit-reached-use"
                  >
                    {t("own.rc.use")}
                  </button>
                </Show>
              </Show>
              <button
                type="button"
                class="own-btn"
                data-size="sm"
                onClick={() => openSwitcher({ serverKey: props.serverKey, sessionID: props.sessionID })}
              >
                {t("own.rc.switchOther")}
              </button>
            </div>
          </div>
          <Show when={dialog()}>
            <Suspense>
              <ResetCreditDialog accountID={props.accountID} onClose={() => toggle(false)} />
            </Suspense>
          </Show>
        </div>
      )}
    </Show>
  )
}
