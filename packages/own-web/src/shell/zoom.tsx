// Window zoom UI (03 §4.2.1, 05 §7.9), on hosts with `host.window.zoom` (desktop) only; zoom-state.ts has the state.
//  - ZoomLayer (once per window, AppShell): the zoom keys (Ctrl+= / Ctrl+- / Ctrl+0, rebindable, palette), and the
//    title bar's indicator: a `110%` pill left of the window buttons while the zoom is not 100 %. The band rows keep
//    its place free (`:root[data-own-zoomed]`, zoom.css). The pill opens the bubble with the control; a change from
//    the keys, Ctrl+wheel or another window shows the same bubble briefly (FLASH_MS), at 100 % too.
//  - ZoomControl: `−  110%  +  초기화(100%)`, in the bubble and in 설정 > 일반 `화면 크기`.
// The layer comes after the header and the work panel in .own-app on purpose: Electron builds the window's drag area
// from the page's app regions in document order, so the pill's `no-drag` must come after the header's `drag`.
import "./zoom.css"
import { createEffect, onCleanup, Show } from "solid-js"
import { useHost } from "@/host"
import { useI18n } from "@/i18n"
import { useShortcut } from "@/keyboard"
import { zoomPercent, zoomState, type ZoomState } from "./zoom-state"

export function ZoomLayer() {
  const zoom = useHost().window?.zoom
  if (!zoom) return null
  const i18n = useI18n()
  const state = zoomState(zoom)
  useShortcut("zoom.in", () => state.step("in"))
  useShortcut("zoom.out", () => state.step("out"))
  useShortcut("zoom.reset", () => state.reset())
  const root = document.documentElement
  createEffect(() => root.toggleAttribute("data-own-zoomed", !state.atDefault()))
  onCleanup(() => root.removeAttribute("data-own-zoomed"))

  let bubble!: HTMLDivElement
  let pill: HTMLButtonElement | undefined
  createEffect(() => {
    const shown = state.bubble() !== "closed"
    if (shown === bubble.matches(":popover-open")) return
    if (shown) bubble.showPopover()
    else bubble.hidePopover()
  })
  // An opened bubble closes on a click outside it and on Esc (a `manual` popover has no light dismiss: a flash must
  // not close the menus and popovers that are open under it). A flash leaves Esc to whatever has the focus.
  const outside = (event: PointerEvent) => {
    if (state.bubble() !== "open") return
    const target = event.target as Node | null
    if (target && (bubble.contains(target) || pill?.contains(target))) return
    state.close()
  }
  const escape = (event: KeyboardEvent) => {
    const focused = bubble.contains(document.activeElement)
    if (event.code !== "Escape" || (state.bubble() !== "open" && !focused)) return
    event.stopPropagation()
    state.close()
    if (focused) pill?.focus()
  }
  document.addEventListener("pointerdown", outside, true)
  document.addEventListener("keydown", escape, true)
  onCleanup(() => {
    document.removeEventListener("pointerdown", outside, true)
    document.removeEventListener("keydown", escape, true)
  })

  return (
    <>
      <Show when={!state.atDefault()}>
        <button
          ref={pill}
          type="button"
          class="own-zoom-pill"
          aria-label={i18n.t("own.zoom.indicator", { percent: zoomPercent(state.factor()) })}
          title={i18n.t("own.zoom.indicator", { percent: zoomPercent(state.factor()) })}
          aria-haspopup="dialog"
          aria-expanded={state.bubble() !== "closed"}
          data-testid="zoom-indicator"
          onClick={() => {
            if (state.bubble() === "open") return state.close()
            state.open()
            if (!bubble.matches(":popover-open")) bubble.showPopover()
            bubble.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus()
          }}
        >
          {zoomPercent(state.factor())}
        </button>
      </Show>
      <div
        ref={bubble}
        popover="manual"
        role="dialog"
        aria-label={i18n.t("own.zoom.label")}
        class="own-zoom-bubble"
        data-testid="zoom-bubble"
        data-mode={state.bubble()}
        onPointerEnter={() => state.hold(true)}
        onPointerLeave={() => state.hold(false)}
        onFocusIn={() => state.hold(true)}
        onFocusOut={() => state.hold(false)}
      >
        <ZoomControl state={state} testid="zoom-bubble-control" />
      </div>
    </>
  )
}

/** `−  110%  +  초기화(100%)`. `quiet`: its changes do not flash the title bar's bubble (the control shows them). */
export function ZoomControl(props: { readonly state: ZoomState; readonly quiet?: boolean; readonly testid: string }) {
  const i18n = useI18n()
  const ask = () => ({ quiet: props.quiet })
  return (
    <div class="own-zoom-control" role="group" aria-label={i18n.t("own.zoom.label")} data-testid={props.testid}>
      <button
        type="button"
        class="own-zoom-step own-target"
        aria-label={i18n.t("own.zoom.out")}
        title={i18n.t("own.zoom.out")}
        disabled={props.state.atMin()}
        data-testid={`${props.testid}-out`}
        onClick={() => props.state.step("out", ask())}
      >
        −
      </button>
      <output class="own-zoom-value" aria-live="polite" data-testid={`${props.testid}-value`}>
        {zoomPercent(props.state.factor())}
      </output>
      <button
        type="button"
        class="own-zoom-step own-target"
        aria-label={i18n.t("own.zoom.in")}
        title={i18n.t("own.zoom.in")}
        disabled={props.state.atMax()}
        data-testid={`${props.testid}-in`}
        onClick={() => props.state.step("in", ask())}
      >
        +
      </button>
      <button
        type="button"
        class="own-zoom-reset own-target"
        disabled={props.state.atDefault()}
        data-testid={`${props.testid}-reset`}
        onClick={() => props.state.reset(ask())}
      >
        {i18n.t("own.zoom.reset")}
      </button>
    </div>
  )
}
