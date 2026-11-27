// The composer's `속도: 표준 | Fast | Ultrafast` beside the reasoning effort (02 §4.8, 03 §4.6, user decisions of
// 2026-10-06 and 2026-10-10): a root session's switch, never stored in a preset. The menu lists the speeds the main's
// account and model offer, each with its mark and badge (`Fast · 한도 ×2.5`, an API key's price, the Claude
// subscription's usage-credit price, speed-mark.tsx); a refused or cooling one is disabled with its note. A main without a faster speed (DeepSeek, a
// Codex plan without priority, a provider own does not run) keeps the control on screen, grey, with the reason.
// On the new-conversation screen it reads `speed.offers` for the target on screen, again on every account or model
// change, and keeps a pending choice that `startSpeed` applies before the first prompt (the next new conversation
// starts at Standard again). Changes run through speed-flow.ts: a session's change asks `session.speed.set{dryRun}`
// first (the cost dialog, the Claude consent); the service's own changes arrive as `session.speed.changed` and show as
// a toast. A remote session's consent is this PC's (04 §8.11.9): the card says so and `plugin.claudeAuth.fastAck`
// records it here.
import { createEffect, createSignal, For, lazy, onCleanup, Show, Suspense, untrack } from "solid-js"
import { useData, type ServerKey, type ServerRuntime } from "@/data"
import { useI18n } from "@/i18n"
import { eventCode } from "@/keyboard"
import { useServersText } from "@/servers/strings"
import { minuteNow } from "@/shell/clock"
import { showToast, type TargetRef } from "@/switcher"
import { fitMenu } from "./fit"
import {
  active,
  button,
  changeLines,
  items,
  noneNote,
  notice,
  offerBadge,
  offerNote,
  speedName,
  type Shown,
} from "./speed"
import {
  closeAsk,
  confirmSpeed,
  landAfterSwitch,
  newKey,
  pendingChoice,
  requestSpeed,
  speedFlow,
  targetView,
  watchTargetOffers,
  type SpeedAsk,
  type SpeedEnv,
} from "./speed-flow"
import { SpeedMark } from "./speed-mark"

const Dialog = lazy(() => import("@/limits/kit").then((module) => ({ default: module.Dialog })))

/** The usage-credit price a consent card shows (the Claude subscription slot's `extra` billing). */
function extraPrice(ask: SpeedAsk) {
  const billing = ask.offer?.billing
  return billing?.type === "extra" ? billing : undefined
}

export function SpeedButton(props: {
  readonly runtime: ServerRuntime
  readonly serverKey: ServerKey
  /** `undefined` on the new-conversation screen: the control then follows `target`. */
  readonly sessionID: string | undefined
  /** The new conversation's account and model (03 §5.1). */
  readonly target: TargetRef | undefined
  readonly disabled?: boolean
}) {
  const i18n = useI18n()
  const data = useData()
  const servers = useServersText()
  const [open, setOpen] = createSignal(false)
  let trigger: HTMLButtonElement | undefined
  let menu: HTMLDivElement | undefined
  const env = (): SpeedEnv => ({
    runtime: props.runtime,
    serverKey: props.serverKey,
    i18n,
    fastAck: () => data.local().rpc.call("plugin.claudeAuth.fastAck", {}),
  })
  const key = () => props.sessionID ?? newKey(props.serverKey)
  const view = (): Shown | undefined => {
    if (props.sessionID) return props.runtime.own.state.sessionSpeed[props.sessionID]
    const pending = pendingChoice(props.serverKey)
    return targetView(props.runtime.own, props.target, pending.choice, pending.consent)
  }
  const readable = () => props.runtime.rpc.allowed(props.sessionID ? "session.speed.get" : "speed.offers")
  const visible = () => props.runtime.own.state.status === "ready" && readable() && !!view()
  const settable = () => !props.sessionID || props.runtime.rpc.allowed("session.speed.set")
  const busy = () => !!speedFlow.busy[key()]

  // The root's speed view while this composer shows it; the service's own changes as a toast.
  createEffect(() => {
    const sessionID = props.sessionID
    if (!sessionID || !props.runtime.rpc.allowed("session.speed.get")) return
    onCleanup(props.runtime.own.watchSpeed(sessionID))
    onCleanup(
      props.runtime.own.on("session.speed.changed", (event) => {
        if (event.data.sessionID !== sessionID) return
        const message = notice(i18n, event.data.reason, event.data.effective, event.data.choice, event.data.cause)
        if (message) showToast({ message })
      }),
    )
  })
  // A new conversation: what the target on screen offers, read again on every account or model change (the user's
  // 2026-10-10 report: starting on DeepSeek and switching to ChatGPT must show the choices at once).
  watchTargetOffers(props.runtime.own, () =>
    props.sessionID || !props.runtime.rpc.allowed("speed.offers") ? undefined : props.target,
  )
  // A switcher apply that changed the model and the speed: the speed once the session runs on the new main.
  createEffect(() => {
    const sessionID = props.sessionID
    const model = sessionID ? props.runtime.own.state.binding[sessionID]?.model : undefined
    if (!sessionID || !model || !speedFlow.after[sessionID]) return
    // The fields, read here: a new binding is reconciled into the same object, so only they change.
    const main = { providerID: model.providerID, id: model.id }
    untrack(() => void landAfterSwitch(env(), sessionID, main).catch(report))
  })

  const close = (refocus = true) => {
    setOpen(false)
    document.removeEventListener("pointerdown", outside, true)
    if (refocus) trigger?.focus()
  }
  const outside = (event: PointerEvent) => {
    if (event.target instanceof Node && (menu?.contains(event.target) || trigger?.contains(event.target))) return
    close(false)
  }
  onCleanup(() => document.removeEventListener("pointerdown", outside, true))

  function onMenuKey(event: KeyboardEvent) {
    const code = eventCode(event)
    const rows = Array.from(menu?.querySelectorAll<HTMLElement>('[role="menuitemradio"]:not([disabled])') ?? [])
    const index = rows.indexOf(document.activeElement as HTMLElement)
    if (code === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      return close()
    }
    if (code === "ArrowDown" || code === "ArrowUp") {
      event.preventDefault()
      const next = code === "ArrowDown" ? (index + 1) % rows.length : (index - 1 + rows.length) % rows.length
      rows[next]?.focus()
    }
  }

  return (
    <Show when={visible() && view()}>
      {(current) => {
        const state = () => button(i18n, current())
        const changeable = () => active(current()) && settable()
        const title = () =>
          state().note ??
          (changeable() ? undefined : noneNote(i18n, current())) ??
          i18n.t(props.sessionID ? "own.speed.title" : "own.speed.newTitle")
        return (
          // The reason also on the wrap: a disabled button shows no tooltip in every browser.
          <span class="own-cp-variant-wrap" data-testid="composer-speed-wrap" title={title()}>
            <button
              ref={trigger}
              type="button"
              class="own-cp-tool"
              aria-haspopup="menu"
              aria-expanded={open()}
              data-testid="composer-speed"
              data-dim={state().dim || !changeable() ? "" : undefined}
              data-none={current().none}
              title={title()}
              disabled={props.disabled || busy() || !changeable()}
              onClick={() => {
                if (open()) return close()
                setOpen(true)
                document.addEventListener("pointerdown", outside, true)
                queueMicrotask(() => {
                  fitMenu(menu)
                  menu?.querySelector<HTMLElement>('[aria-checked="true"], [role="menuitemradio"]')?.focus()
                })
              }}
            >
              <SpeedMark choice={state().mark} />
              {state().label}
              <span class="own-cp-caret" aria-hidden="true">
                ▾
              </span>
            </button>
            <Show when={open()}>
              <div
                ref={menu}
                class="own-cp-menu"
                role="menu"
                aria-label={i18n.t("own.speed.label")}
                data-testid="composer-speed-menu"
                onKeyDown={onMenuKey}
              >
                <For each={items(current())}>
                  {(item) => (
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={item.choice === (props.sessionID ? current().choice : current().effective)}
                      class="own-cp-menu-item"
                      data-speed={item.choice}
                      disabled={item.disabled}
                      title={item.offer ? offerNote(i18n, item.offer, minuteNow()) : undefined}
                      onClick={() => {
                        close()
                        void requestSpeed(env(), {
                          sessionID: props.sessionID,
                          to: item.choice,
                          view: current(),
                          ...(item.offer ? { offer: item.offer } : {}),
                        })
                      }}
                    >
                      <SpeedMark choice={item.choice} />
                      {item.offer ? offerBadge(i18n, item.offer, minuteNow()) : speedName(i18n, item.choice)}
                    </button>
                  )}
                </For>
              </div>
            </Show>
            <Show when={speedFlow.ask?.key === key() ? speedFlow.ask : undefined}>
              {(pending) => (
                <Suspense>
                  <Dialog
                    open
                    testid={pending().consent ? "speed-consent-dialog" : "speed-cost-dialog"}
                    title={
                      <span class="own-speed-title">
                        <SpeedMark choice={pending().to} />
                        {pending().consent
                          ? i18n.t("own.speed.consent.title")
                          : i18n.t("own.speed.dialog.on", { speed: speedName(i18n, pending().to) })}
                      </span>
                    }
                    onClose={closeAsk}
                    footer={
                      <>
                        <button type="button" class="own-cp-btn" onClick={closeAsk}>
                          {i18n.t("own.speed.dialog.cancel")}
                        </button>
                        <button
                          type="button"
                          class="own-cp-btn own-cp-btn-primary"
                          data-testid="speed-confirm"
                          onClick={() => void confirmSpeed(env(), pending())}
                        >
                          {pending().consent ? i18n.t("own.speed.consent.accept") : i18n.t("own.speed.dialog.confirm")}
                        </button>
                      </>
                    }
                  >
                    <Show when={pending().consent}>
                      <p>{i18n.t("own.speed.consent.body")}</p>
                      <Show when={pending().local}>
                        <p data-testid="speed-consent-local">{servers("own.remote.claudeSlot.fastLocal")}</p>
                      </Show>
                      <Show when={extraPrice(pending())}>
                        {(price) => (
                          <p data-testid="speed-consent-price">
                            {i18n.t("own.speed.consent.price", { input: price().input, output: price().output })}
                          </p>
                        )}
                      </Show>
                    </Show>
                    <Show when={pending().change}>
                      {(change) => (
                        <For each={changeLines(i18n, change(), { consent: pending().consent })}>
                          {(line) => <p data-testid="speed-cost-line">{line}</p>}
                        </For>
                      )}
                    </Show>
                  </Dialog>
                </Suspense>
              )}
            </Show>
          </span>
        )
      }}
    </Show>
  )
}

function report(error: unknown) {
  console.error("[own-web] speed", error)
}
