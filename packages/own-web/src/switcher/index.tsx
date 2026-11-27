// Switcher module entry (03 §5.2, §6, owner: switcher): the "모델 @ 계정" switcher popover, the switch-cost dialog,
// switch notifications, the running-on pill and the pending-switch chip. `<Switcher>` is mounted once by the shell;
// it owns `switcher.open` (Ctrl+. / Ctrl+'), keeps the route in the shared control and renders the popover and the
// dialog as lazy chunks (03 §20.2 R5), prefetched when the page is idle so the first Ctrl+. is instant.
import { createEffect, lazy, on, onCleanup, onMount, Show, Suspense } from "solid-js"
import { useData, type ServerKey } from "@/data"
import { useI18n } from "@/i18n"
import { useShortcut } from "@/keyboard"
import { useRouter } from "@/routing/router"
import type { Route } from "@/routing/routes"
import { closeSwitcher, openSwitcher, switcherControl } from "./control"
import { targetAccount } from "./labels"
import { stateOf } from "./pending-chip"
import { showToast } from "./toast"
import "./switcher.css"
import { inFocusedPane, usePaneFocused } from "@/shell/pane-context"

export { closeSwitcher, openSwitcher, switcherControl, type SwitcherRequest } from "./control"
export type { TargetRef } from "./cost"
export { PendingSwitchChip } from "./pending-chip"
export { RunningOnPill, type SwitcherProps } from "./pill"
export { showToast, Toasts, type ToastInput } from "./toast"

const Popover = lazy(() => import("./popover"))
const CostDialog = lazy(() => import("./cost-dialog"))

/** A `switch.recorded` right after this window announced the same switch is not toasted again. */
const ANNOUNCE_WINDOW_MS = 15_000

export function Switcher(props: { readonly serverKey: () => ServerKey; readonly sessionID: () => string | undefined }) {
  const data = useData()
  const i18n = useI18n()
  const router = useRouter()

  // 03 §4.1.1: with split panes the switcher works for the focused pane's session.
  const focused = usePaneFocused()
  createEffect(() => {
    if (focused()) switcherControl.setRoute(props.serverKey(), props.sessionID())
  })
  // Another session on screen: the popover belongs to the old one.
  createEffect(
    on(
      () => `${props.serverKey()}/${props.sessionID() ?? ""}`,
      () => {
        const open = switcherControl.state.open
        if (open && (open.serverKey !== props.serverKey() || open.sessionID !== props.sessionID())) closeSwitcher()
      },
      { defer: true },
    ),
  )

  useShortcut("switcher.open", () => {
    if (switcherControl.state.open) return closeSwitcher()
    const anchor = inFocusedPane('[data-testid="composer-switcher"]')
    openSwitcher({ anchor })
  })

  // 03 §9: scheduled and compaction-prepared switches land later; tell the user when they do.
  createEffect(() => {
    const runtime = data.get(props.serverKey())
    if (!runtime) return
    onCleanup(
      runtime.own.on("switch.recorded", (event) => {
        const detail = event.data
        if (detail.actual || detail.sessionID !== props.sessionID()) return
        const announced = switcherControl.state.announced[detail.sessionID]
        if (announced && Date.now() - announced < ANNOUNCE_WINDOW_MS) return
        // The session's account (SL-17): the record (SWITCHING until this lands) names a switch to Claude's account.
        const to = targetAccount(runtime, detail.to.providerID, detail.sessionID)?.label ?? detail.to.providerID
        const key =
          detail.strategy === "cold-point"
            ? "own.switch.scheduledApplied"
            : detail.strategy === "compact-then-switch"
              ? "own.switch.compactApplied"
              : "own.switch.applied"
        showToast({ message: i18n.t(key, { to }) })
      }),
    )
    // 03 §6.5: a compact-then-switch whose compaction failed goes back to PLANNED; offer "지금 전환".
    onCleanup(
      runtime.own.on("alert", (event) => {
        const sessionID = event.data.sessionID
        if (event.data.code !== "compaction_failed" || !sessionID || sessionID !== props.sessionID()) return
        // The alert comes before the router re-plans, so the target is still on COMPACTING (or already PLANNED).
        const state = runtime.own.state.switchState[sessionID]
        const target = (stateOf(state, "PLANNED") ?? stateOf(state, "COMPACTING"))?.target
        showToast({
          message: i18n.t("own.switch.compactFailed"),
          tone: "danger",
          action: target
            ? {
                label: i18n.t("own.switch.optNow"),
                run: async () => {
                  const { applyNow } = await import("./flow")
                  const env = {
                    runtime,
                    serverKey: props.serverKey(),
                    i18n,
                    navigate: (route: Route) => router.navigate(route),
                  }
                  await applyNow(env, { sessionID, target })
                },
              }
            : undefined,
        })
      }),
    )
  })

  onMount(() => {
    // Prefetch the lazy chunks once the page is idle: not in the first bundle, but ready before the first Ctrl+.
    const prefetch = () => {
      void import("./popover")
      void import("./cost-dialog")
    }
    if (typeof requestIdleCallback === "function") requestIdleCallback(prefetch, { timeout: 5_000 })
    else setTimeout(prefetch, 2_000)
  })

  return (
    <>
      <Show when={switcherControl.state.open}>
        {(request) => (
          <Show when={data.get(request().serverKey)}>
            {(runtime) => (
              <Suspense>
                <Popover runtime={runtime()} request={request()} onClose={closeSwitcher} />
              </Suspense>
            )}
          </Show>
        )}
      </Show>
      <Show when={switcherControl.state.dialog}>
        {(dialog) => (
          <Show when={data.get(dialog().serverKey)}>
            {(runtime) => (
              <Suspense>
                <CostDialog runtime={runtime()} dialog={dialog()} onClose={() => switcherControl.closeDialog()} />
              </Suspense>
            )}
          </Show>
        )}
      </Show>
    </>
  )
}
