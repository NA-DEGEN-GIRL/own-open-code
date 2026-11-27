// Header "실행 위치" pill (03 §4.4): `● GPT-5.6 Sol @ 개인 Pro · 캐시 따뜻함`, a spinner while the session runs, the
// pending switch as a second line, and the two warning variants of 03 §5.2.1 (built-in provider, unpinned session)
// with their actions. Clicking opens the switcher anchored here. First chunk: small and store-driven. A remote
// session on the Claude slot this PC relays carries `PC 경유` next to it (04 §8.11.12).
import { createEffect, For, onCleanup, Show } from "solid-js"
import { claudeAccountName } from "@/accounts/claude-name"
import { useData, type ServerKey } from "@/data"
import { useI18n } from "@/i18n"
import { useRouter } from "@/routing/router"
import { serverClaude, viaPc } from "@/servers/claude"
import { useServersText } from "@/servers/strings"
import { minuteNow } from "@/shell/clock"
import { openSwitcher } from "./control"
import { showToast } from "./toast"
import { cacheText, modelName, runningOnParts, slotOf, targetAccount } from "./labels"
import { stateOf } from "./pending-chip"

export interface SwitcherProps {
  readonly serverKey: () => ServerKey
  readonly sessionID: () => string | undefined
}

export function RunningOnPill(props: SwitcherProps) {
  const data = useData()
  const i18n = useI18n()
  const servers = useServersText()
  const router = useRouter()
  const runtime = () => data.get(props.serverKey())
  let button: HTMLButtonElement | undefined

  createEffect(() => {
    const store = runtime()?.own
    const sessionID = props.sessionID()
    if (!store || !sessionID) return
    onCleanup(store.watchVisible([sessionID]))
    onCleanup(store.watchOpen(sessionID))
    // 02 §8.8: this conversation moved to another Claude account because one ran out (the router's message).
    onCleanup(
      store.on("alert", (event) => {
        if (event.data.code === "claude_account_switched" && event.data.sessionID === sessionID)
          showToast({ message: event.data.message })
      }),
    )
  })

  const binding = () => {
    const sessionID = props.sessionID()
    return sessionID ? runtime()?.own.state.binding[sessionID] : undefined
  }
  const account = () => {
    const current = binding()
    const own = runtime()?.own
    if (!current?.model || !own) return undefined
    // 02 §8.7: a Claude conversation's own account among several Claude accounts.
    const bound = current.accountID ? own.state.accounts[current.accountID] : undefined
    return bound?.providerID === current.model.providerID ? bound : own.accountFor(current.model.providerID)
  }
  const relayed = () => viaPc(serverClaude(runtime()), account()?.kind)
  const running = () => {
    const sessionID = props.sessionID()
    return sessionID ? runtime()?.data.session.status(sessionID) === "running" : false
  }
  const cache = () => {
    const sessionID = props.sessionID()
    const model = binding()?.model
    const own = runtime()?.own
    if (!sessionID || !model || !own) return undefined
    const snapshot = own.state.cache[sessionID]
    if (!snapshot) return undefined
    return cacheText(i18n, slotOf(snapshot, model.providerID, binding()?.accountID), minuteNow())
  }
  const pending = () => {
    const sessionID = props.sessionID()
    return sessionID ? stateOf(runtime()?.own.state.switchState[sessionID], "WAIT_SAFE") : undefined
  }
  const pin = async () => {
    const current = runtime()
    const sessionID = props.sessionID()
    if (!current || !sessionID) return
    const { pinCurrentDefault } = await import("./flow")
    await pinCurrentDefault(
      { runtime: current, serverKey: props.serverKey(), i18n, navigate: (route) => router.navigate(route) },
      sessionID,
    )
  }
  const open = () => openSwitcher({ anchor: button })

  return (
    <Show when={binding()}>
      {(current) => (
        <span class="own-sw-pill-wrap">
          <button
            ref={button}
            type="button"
            class="own-sw-pill"
            classList={{ "own-sw-pill-warn": !current().model || current().builtin }}
            data-testid="running-on-pill"
            aria-haspopup="dialog"
            aria-busy={running()}
            title={
              !current().model
                ? i18n.t("own.binding.unpinnedWarn")
                : current().builtin
                  ? i18n.t("own.binding.builtinWarn")
                  : undefined
            }
            onClick={open}
          >
            <Show when={running()}>
              <span class="own-run-mark" role="img" aria-label={i18n.t("own.pill.running")} />
            </Show>
            <Show
              when={current().model}
              fallback={
                <>
                  <span class="own-sw-dot own-sw-dot-empty" aria-hidden="true" />
                  <span data-testid="running-on">{i18n.t("own.binding.unpinned")}</span>
                  <span aria-hidden="true"> ⚠</span>
                </>
              }
            >
              {(model) => (
                <>
                  <Show
                    when={!current().builtin && account()}
                    fallback={<span class="own-sw-dot own-sw-dot-empty" aria-hidden="true" />}
                  >
                    {(owner) => <span class="own-sw-dot" data-color={owner().color} aria-hidden="true" />}
                  </Show>
                  {/* The model gives way before the account (UX 2026-10-26, ./switcher.css). */}
                  <span class="own-sw-pill-label" data-testid="running-on">
                    <Show
                      when={!current().builtin}
                      fallback={
                        <span data-part="model">{i18n.t("own.binding.builtin", { provider: model().providerID })}</span>
                      }
                    >
                      <For
                        each={runningOnParts(
                          i18n,
                          modelName(runtime()!, model()),
                          account() ? claudeAccountName(i18n, account()!) : model().providerID,
                        )}
                      >
                        {(segment) => <span data-part={segment.part ?? "sep"}>{segment.text}</span>}
                      </For>
                    </Show>
                  </span>
                  <Show when={current().builtin}>
                    <span aria-hidden="true"> ⚠</span>
                  </Show>
                  <Show when={!current().builtin && cache()}>
                    {(state) => (
                      <span class="own-sw-pill-cache" data-state={state().state}>
                        {" · "}
                        {i18n.t("own.pill.cache", { state: state().text })}
                      </span>
                    )}
                  </Show>
                </>
              )}
            </Show>
          </button>
          <Show when={!current().builtin && relayed()}>
            <span class="own-sw-tag" title={servers("own.remote.claudeSlot.badgeHelp")} data-testid="running-on-via-pc">
              {servers("own.remote.claudeSlot.badge")}
            </span>
          </Show>
          <Show when={pending()}>
            {(wait) => (
              <span class="own-sw-pill-next" data-testid="running-on-next">
                →{" "}
                {i18n.t("own.session.afterTurn", {
                  model: modelName(runtime()!, wait().target),
                  // SL-17: a switch to Claude lands on the account its record names, not the binding's company.
                  account:
                    targetAccount(runtime()!, wait().target.providerID, props.sessionID()!, wait().accountID)?.label ??
                    wait().target.providerID,
                })}
              </span>
            )}
          </Show>
          <Show when={current().builtin && runtime()?.own.rpc.allowed("switch.apply")}>
            <button type="button" class="own-sw-pill-action" onClick={open}>
              {i18n.t("own.binding.moveToRouter")}
            </button>
          </Show>
          <Show when={!current().model && runtime()?.own.rpc.allowed("switch.apply")}>
            <button type="button" class="own-sw-pill-action" onClick={() => void pin()}>
              {i18n.t("own.binding.pin")}
            </button>
          </Show>
        </span>
      )}
    </Show>
  )
}
