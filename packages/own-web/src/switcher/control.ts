// Window-wide switcher state. The composer button, the header pill, the limits tab ("이 세션을 여기로 전환"), banners
// ("다른 계정으로 전환…") and the palette open the same popover (03 §5.2 "어디서 열어도 같은 팝오버"); the shell mounts
// one `<Switcher>` that renders it. Also keeps the new-session target per server (03 §5.1), recent combinations and
// per-session confirm overrides that the UI set in this window.
import { createRoot } from "solid-js"
import { createStore, produce } from "solid-js/store"
import type { Estimate } from "@own/protocol"
import type { ServerKey } from "@/data"
import type { TargetRef } from "./cost"

export interface SwitcherRequest {
  /** Element to place the popover against. */
  readonly anchor?: HTMLElement | null
  /** Where focus goes back on close (03 §11); default: the element focused when it opened, else the anchor. */
  readonly opener?: Element | null
  /** Preselect this account (limits tab, "라우터 계정으로 옮기기…"). */
  readonly accountID?: string
  /** Preselect a model/variant (variant button with an `inline` cost). */
  readonly target?: TargetRef
  /** `switch.suggested` candidates: their accounts come first (03 §6.6). */
  readonly candidates?: readonly string[]
}

export interface OpenState extends SwitcherRequest {
  readonly serverKey: ServerKey
  readonly sessionID?: string
  /** Changes on every open, so the popover resets its selection. */
  readonly seq: number
}

export interface DialogState {
  readonly serverKey: ServerKey
  readonly sessionID: string
  readonly target: TargetRef
  readonly estimate: Estimate.Result
  readonly opener?: Element | null
}

interface ControlState {
  route: { serverKey: ServerKey; sessionID?: string }
  open?: OpenState
  dialog?: DialogState
  /** Target of the next new session per server (03 §5.1). */
  newSession: Record<ServerKey, TargetRef | undefined>
  /** `switch.setConfirmOverride` values set from this window, per session. */
  override: Record<string, number | undefined>
  /** When this window last announced an applied switch per session (so `switch.recorded` does not toast twice). */
  announced: Record<string, number | undefined>
}

const RECENT_KEY = "own.web.switcher.recent"
const RECENT_LIMIT = 4

const control = createRoot(() => {
  const [state, setState] = createStore<ControlState>({
    route: { serverKey: "local" },
    newSession: {},
    override: {},
    announced: {},
  })
  const [recent, setRecent] = createStore<{ list: TargetRef[] }>({ list: readRecent() })
  let seq = 0
  return {
    state,
    recent,
    setRoute(serverKey: ServerKey, sessionID: string | undefined) {
      setState("route", { serverKey, sessionID })
    },
    open(request: SwitcherRequest = {}) {
      const opener = request.opener ?? (typeof document === "object" ? document.activeElement : null)
      setState("open", { ...state.route, ...request, opener, seq: ++seq })
    },
    close() {
      const open = state.open
      setState("open", undefined)
      const target = [open?.opener, open?.anchor].find(
        (element): element is HTMLElement => element instanceof HTMLElement && element.isConnected,
      )
      target?.focus()
    },
    openDialog(dialog: DialogState) {
      setState("dialog", dialog)
    },
    closeDialog() {
      const opener = state.dialog?.opener
      setState("dialog", undefined)
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus()
    },
    setNewSessionTarget(serverKey: ServerKey, target: TargetRef | undefined) {
      setState("newSession", serverKey, target)
    },
    setOverride(sessionID: string, value: number | undefined) {
      setState("override", sessionID, value)
    },
    markAnnounced(sessionID: string, at = Date.now()) {
      setState("announced", sessionID, at)
    },
    remember(target: TargetRef) {
      setRecent(
        "list",
        produce((list) => {
          const index = list.findIndex((item) => sameCombination(item, target))
          if (index >= 0) list.splice(index, 1)
          list.unshift({ ...target })
          list.length = Math.min(list.length, RECENT_LIMIT)
        }),
      )
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(recent.list))
      } catch {}
    },
  }
})

export const switcherControl = control

/** Opens the "모델 @ 계정" switcher for the session on screen (03 §5.2). */
export function openSwitcher(request?: SwitcherRequest) {
  control.open(request)
}

export function closeSwitcher() {
  control.close()
}

function readRecent(): TargetRef[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]")
    if (!Array.isArray(parsed)) return []
    // An older window stored the model's default effort both as `default` and as no variant: one chip each looked the same.
    return parsed
      .filter(isRef)
      .filter((ref, index, refs) => refs.findIndex((other) => sameCombination(other, ref)) === index)
      .slice(0, RECENT_LIMIT)
  } catch {
    return []
  }
}

/** The same recent combination: the model's default effort is the same whether stored as `default` or as none. */
function sameCombination(a: TargetRef, b: TargetRef) {
  const effort = (ref: TargetRef) => (ref.variant === "default" ? undefined : ref.variant)
  return a.providerID === b.providerID && a.id === b.id && effort(a) === effort(b)
}

function isRef(value: unknown): value is TargetRef {
  if (typeof value !== "object" || value === null) return false
  return (
    "providerID" in value &&
    typeof value.providerID === "string" &&
    "id" in value &&
    typeof value.id === "string" &&
    (!("variant" in value) || value.variant === undefined || typeof value.variant === "string")
  )
}
