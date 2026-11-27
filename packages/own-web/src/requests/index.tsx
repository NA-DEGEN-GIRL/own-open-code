// Requests module entry (03 §18.1 권한 승인 dock, §18.2 질문·폼 dock과 웹 검색 동의, §18.8 스레드별 승인 모드, §9 알림).
// First chunk: the request model (memos over createData), the header approval pill and the notification hook. The
// dock views, the approval menu and the settings page are lazy chunks (03 §20.4 "새 dock·대화상자는 lazy").
//
// Wiring (integrator): `<RequestDocks>` above the queue dock in the composer (03 §4.6 order: 권한 → 질문·폼 → 대기열),
// `<ApprovalModePill>` in the session header (4.4; with no session it edits the new-session default, 5.1),
// `<RequestNotifications />` once in the shell, `newSessionApproval.value()` as the composer's new-session mode, and
// `lazy(() => import("@/requests/settings"))` for 설정 > 승인·권한.
import { createEffect, createSignal, lazy, Show, Suspense } from "solid-js"
import { useData, type ServerKey } from "@/data"
import { useHost } from "@/host"
import { useI18n } from "@/i18n"
import { isMac, useShortcut } from "@/keyboard"
import { useRouter } from "@/routing/router"
import { createApprovalState, MODE_KEY, newSessionApproval, type ModeLabel } from "./approval"
import { createRequestModel } from "./model"
import { createRequestNotifier } from "./notify"
import { useRequestsText } from "./strings"

export { newSessionApproval, MODES, type SetMode } from "./approval"
export type { RequestItem, RequestModel } from "./model"

const DockView = lazy(() => import("./docks"))
const ApprovalMenu = lazy(() => import("./approval-menu"))

export interface RequestsProps {
  readonly serverKey: () => ServerKey
  /** `undefined` on the new-session screen. */
  readonly sessionID: () => string | undefined
}

/** Permission, question/form and web search docks of the open session and its subagents (03 §18.1–18.2). */
export function RequestDocks(props: RequestsProps) {
  const data = useData()
  const text = useRequestsText()
  const model = createRequestModel({
    runtime: () => data.get(props.serverKey()),
    sessionID: props.sessionID,
    text: {
      failed: () => text("own.requests.failed"),
      cancelledByReload: () => text("own.requests.cancelledByReload"),
    },
  })
  let root: HTMLDivElement | undefined
  // The dock never takes focus by itself (the user may be typing); Ctrl+Shift+Enter moves there (03 §18.1, §10).
  useShortcut(
    "dock.focus",
    () => {
      const target = root?.querySelector<HTMLElement>("[data-own-dock-focus]")
      if (!target) return false
      target.focus()
    },
    { when: () => model.items().length > 0 },
  )
  // The view chunk loads with the first request and then stays mounted: the web search "다른 검색 서비스" flow answers
  // one form and waits for the next, and must survive the moment in between when nothing is pending (vendored
  // websearch.ts aborts on cleanup).
  const [used, setUsed] = createSignal(false)
  createEffect(() => {
    if (model.current()) setUsed(true)
  })
  return (
    <div ref={root} class="own-rq-stack" data-testid="request-docks">
      <Show when={used()}>
        <Suspense>
          <DockView model={model} serverKey={props.serverKey} sessionID={props.sessionID} />
        </Suspense>
      </Show>
    </div>
  )
}

/**
 * Header approval-mode pill (03 §4.4): `읽기 전용` / `묻기` / `전체 허용` (warning border), `기본 규칙` when the
 * router set nothing, `사용자 지정` when the rules were edited elsewhere. Opens the mode menu (Ctrl+Shift+A only opens
 * it, never widens permissions by itself, 03 §10). Without a session it edits the new-session default (5.1).
 */
export function ApprovalModePill(props: RequestsProps) {
  const data = useData()
  const i18n = useI18n()
  const text = useRequestsText()
  const state = createApprovalState({ runtime: () => data.get(props.serverKey()), sessionID: props.sessionID })
  const [open, setOpen] = createSignal(false)
  let button: HTMLButtonElement | undefined
  const label = (): ModeLabel | undefined => (props.sessionID() ? state.label() : newSessionApproval.value())
  const labelText = () => {
    const value = label()
    if (value === undefined) return text("own.requests.approval.loading")
    if (value === "default") return text("own.requests.approval.default")
    if (value === "custom") return text("own.requests.approval.custom")
    return i18n.t(MODE_KEY[value])
  }
  const close = () => {
    setOpen(false)
    button?.focus()
  }
  useShortcut("approval.menu", () => void setOpen(true))
  return (
    <>
      <button
        ref={button}
        type="button"
        class="own-target inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-own-border px-2.5 text-[12px] text-own-muted hover:bg-own-hover data-[mode=full]:border-own-warn data-[mode=full]:text-own-warn"
        data-testid="approval-pill"
        data-mode={label() ?? "loading"}
        aria-haspopup="dialog"
        aria-expanded={open()}
        aria-label={text("own.requests.approval.label", { mode: labelText() })}
        title={text("own.requests.approval.label", { mode: labelText() })}
        aria-keyshortcuts={isMac ? "Meta+Shift+A" : "Control+Shift+A"}
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-hidden="true">{label() === "full" ? "⚠" : "⛉"}</span>
        <span class="max-w-[9rem] truncate">{labelText()}</span>
      </button>
      <Show when={open()}>
        <Suspense>
          <ApprovalMenu anchor={button} state={state} session={props.sessionID() !== undefined} onClose={close} />
        </Suspense>
      </Show>
    </>
  )
}

/** OS notifications for requests while the window is hidden or unfocused (03 §9). Mount once in the shell. */
export function RequestNotifications() {
  const data = useData()
  const host = useHost()
  const router = useRouter()
  const text = useRequestsText()
  createRequestNotifier({
    data,
    capability: host.capabilities.osNotifications,
    notify: host.notify ? (input) => host.notify?.(input) : undefined,
    focused: () => host.window?.isFocused() ?? document.hasFocus(),
    text,
    open: (serverKey, sessionID) => {
      host.window?.show()
      router.navigate({ name: "session", serverKey, sessionID })
    },
  })
  return null
}
