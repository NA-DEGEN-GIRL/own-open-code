// Pieces shared by the permission, form and web search docks (lazy chunk).
import { Show, type JSX } from "solid-js"
import type { ServerKey } from "@/data"
import { useI18n } from "@/i18n"
import { isMac } from "@/keyboard"
import { useRouter } from "@/routing/router"
import type { Origin } from "./model"
import { useRequestsText } from "./strings"

let seq = 0

/** The DockPrompt root is the dock's focus target (Ctrl+Shift+Enter, 03 §18.1) and a labelled group. */
export function frameRef(title: string, keys?: string) {
  return (element: HTMLDivElement) => {
    element.tabIndex = -1
    element.setAttribute("data-own-dock-focus", "")
    element.setAttribute("role", "group")
    element.setAttribute("aria-labelledby", title)
    if (keys) element.setAttribute("aria-keyshortcuts", keys)
  }
}

export function titleID() {
  return `own-rq-title-${++seq}`
}

export function Head(props: {
  readonly id: string
  readonly kind: "permission" | "question"
  readonly title: string
  readonly origin: Origin
  readonly serverKey: ServerKey
  readonly children?: JSX.Element
}) {
  const i18n = useI18n()
  const text = useRequestsText()
  const router = useRouter()
  return (
    <div class="own-rq-head">
      <span class="own-rq-mark" data-kind={props.kind} aria-hidden="true">
        ?
      </span>
      <div class="own-rq-headtext">
        <h3 class="own-rq-title" id={props.id} data-testid="request-title">
          {props.title}
        </h3>
        <Show when={props.origin.agents.length > 0}>
          <div class="own-rq-origin" data-testid="request-origin">
            <span>{i18n.t("own.perm.fromChild", { agent: props.origin.agents.join(" › ") })}</span>
            <button
              type="button"
              class="own-rq-link"
              data-testid="request-open-child"
              onClick={() =>
                router.navigate({ name: "session", serverKey: props.serverKey, sessionID: props.origin.sessionID })
              }
            >
              {text("own.requests.openChild")}
            </button>
          </div>
        </Show>
        {props.children}
      </div>
    </div>
  )
}

/** Key label next to a button (`Enter`, `Ctrl+Enter`/`⌘Enter`, `Esc`). */
export function Kbd(props: { readonly keys: "enter" | "modEnter" | "esc" }) {
  const label = () => {
    if (props.keys === "enter") return "Enter"
    if (props.keys === "esc") return "Esc"
    return isMac ? "⌘Enter" : "Ctrl+Enter"
  }
  return (
    <span class="own-rq-kbd" aria-hidden="true">
      {label()}
    </span>
  )
}

export const MOD_ENTER = isMac ? "Meta+Enter" : "Control+Enter"

export function isEnterKey(event: KeyboardEvent) {
  return event.code === "Enter" || event.code === "NumpadEnter" || (event.code === "" && event.key === "Enter")
}

export function isEscapeKey(event: KeyboardEvent) {
  return event.code === "Escape" || (event.code === "" && event.key === "Escape")
}

/** Keys an IME owns (03 §12 rule 3). */
export function composing(event: KeyboardEvent) {
  return event.isComposing || event.keyCode === 229
}
