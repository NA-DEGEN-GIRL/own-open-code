// PendingSwitchChip (03 §4.6, §6.3, §15.3): the line above the composer text while a switch waits for the turn to
// end (WAIT_SAFE), is being prepared by a compaction (COMPACTING), is scheduled for a cold point (SCHEDULED), or a
// "리셋까지 대기" message is armed (BLOCKED `waitReset`). Values come from `switch.state` only; the UI never sets a
// deadline or an idle time itself. PLANNED is not shown: every `switch.estimate` (opening the switcher) plans.
import { Match, Show, Switch, type JSX } from "solid-js"
import type { OwnState, ServerRuntime } from "@/data"
import { useI18n } from "@/i18n"
import { coming } from "@/limits/format"
import { minuteNow } from "@/shell/clock"
import { accountOf, modelName, targetAccount } from "./labels"
import { currentRef } from "./session"
import { showToast } from "./toast"

type SwitchState = OwnState["switchState"][string]
type StateOf<Name extends SwitchState["state"]> = Extract<SwitchState, { state: Name }>

/** Narrows the stored switch state for `<Match>`. */
export function stateOf<Name extends SwitchState["state"]>(state: SwitchState | undefined, name: Name) {
  return state?.state === name ? (state as StateOf<Name>) : undefined
}

export interface PendingSwitchChipProps {
  readonly runtime: ServerRuntime
  readonly sessionID: string
  /** Messages the composer holds while a compact-then-switch runs (03 §6.5). */
  readonly held: number
  /** Children that keep their account (03 §5.2.1). */
  readonly children: number
}

export function PendingSwitchChip(props: PendingSwitchChipProps) {
  const i18n = useI18n()
  const own = props.runtime.own
  const state = () => own.state.switchState[props.sessionID]
  // The conversation's own accounts (SL-17: the Claude accounts share `anthropic`, so the provider names only the
  // first); a target is the account the switch lands on, which the record names for a switch to Claude.
  const target = (pending: { readonly target: { readonly providerID: string }; readonly accountID?: string }) =>
    targetAccount(props.runtime, pending.target.providerID, props.sessionID, pending.accountID)?.label ??
    pending.target.providerID
  const currentAccount = () => {
    const model = currentRef(props.runtime, props.sessionID)
    return model ? (accountOf(props.runtime, model.providerID, props.sessionID)?.label ?? model.providerID) : ""
  }
  const canCancel = () => own.rpc.allowed("switch.cancel")
  const childNote = () => (props.children > 0 ? ` · ${i18n.t("own.switch.subagents", { n: props.children })}` : "")

  async function cancel() {
    try {
      await props.runtime.rpc.call("switch.cancel", { sessionID: props.sessionID })
      showToast({ message: i18n.t("own.switch.cancelled") })
    } catch (error) {
      console.error("[own-web] switch.cancel failed", error)
    }
  }

  const Line = (line: { readonly state: string; readonly children: JSX.Element }) => (
    <div class="own-sw-chip-line" role="status" data-testid="pending-switch" data-state={line.state}>
      <span class="own-sw-chip-icon" aria-hidden="true">
        ⇄
      </span>
      <span class="min-w-0 flex-1">{line.children}</span>
      <Show when={canCancel()}>
        <button type="button" class="own-sw-chip-link" onClick={() => void cancel()}>
          {i18n.t("own.composer.cancelSwitch")}
        </button>
      </Show>
    </div>
  )

  return (
    <Switch>
      <Match when={stateOf(state(), "WAIT_SAFE")}>
        {(wait) => (
          <Line state="WAIT_SAFE">
            {i18n.t("own.session.afterTurn", {
              model: modelName(props.runtime, wait().target),
              account: target(wait()),
            })}
            {childNote()}
            <span class="own-sw-chip-faint">
              {" · "}
              {i18n.t("own.composer.pendingSendNote", { account: target(wait()) })}
            </span>
          </Line>
        )}
      </Match>
      <Match when={stateOf(state(), "COMPACTING")}>
        {(compacting) => (
          <Line state="COMPACTING">
            {i18n.t("own.composer.compactingSwitch", { account: target(compacting()) })}
            <Show when={props.held > 0}> ({i18n.t("own.composer.held", { n: props.held })})</Show>
          </Line>
        )}
      </Match>
      <Match when={stateOf(state(), "SCHEDULED")}>
        {(scheduled) => {
          const to = () => target(scheduled())
          const minutes = () => Math.round(scheduled().idleMinutes)
          const text = () => {
            if (scheduled().trigger === "idle_ttl")
              return i18n.t("own.composer.scheduledIdle", { to: to(), from: currentAccount(), minutes: minutes() })
            if (scheduled().trigger === "compaction")
              return i18n.t("own.composer.scheduledCompaction", {
                to: to(),
                deadline: coming(i18n, minuteNow(), scheduled().deadline),
              })
            return i18n.t("own.composer.scheduledEither", {
              to: to(),
              minutes: minutes(),
              deadline: coming(i18n, minuteNow(), scheduled().deadline),
            })
          }
          return (
            <Line state="SCHEDULED">
              {text()}
              <Show when={scheduled().uncertain}>
                {" "}
                <span class="own-sw-tag own-sw-dashed">{i18n.t("own.switch.coldUncertain")}</span>
              </Show>
              {childNote()}
              <span class="own-sw-chip-faint">
                {" · "}
                {i18n.t("own.composer.scheduledSendNote", { account: currentAccount() })}
              </span>
            </Line>
          )
        }}
      </Match>
      <Match when={stateOf(state(), "BLOCKED")?.waitReset}>
        {(wait) => (
          <Line state="BLOCKED">
            {i18n.t("own.wait.persistentNote", {
              time: coming(i18n, minuteNow(), wait().resumeAt),
              message: wait().message,
            })}
          </Line>
        )}
      </Match>
    </Switch>
  )
}
