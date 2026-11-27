// Approval-mode menu (03 §18.8, lazy): 읽기 전용 / 묻기 / 전체 허용 for this session, or the new-session default when
// no session is open (5.1). `전체 허용` asks once (no checkbox). Running subagents are named because the router
// PATCHes them too (`실행 중인 하위 에이전트 {n}개에도 적용합니다`). Placed once per open next to the pill (one layout
// read), closed by Esc, a click outside, or choosing.
import { createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { nextFrame } from "@/data/frame"
import { useI18n } from "@/i18n"
import { showToast } from "@/switcher/toast"
import { createModeChoice, MODE_KEY, MODES, newSessionApproval, type ApprovalState, type SetMode } from "./approval"
import { useRequestsText } from "./strings"
import "./requests.css"

export default function ApprovalMenu(props: {
  readonly anchor: HTMLElement | undefined
  readonly state: ApprovalState
  /** `false` on the new-session screen: the choice is the local default for new sessions. */
  readonly session: boolean
  readonly onClose: () => void
}) {
  const i18n = useI18n()
  const text = useRequestsText()
  const [place, setPlace] = createSignal<{ left: number; top: number }>()
  let root: HTMLDivElement | undefined

  const checked = (mode: SetMode) => {
    if (!props.session) return newSessionApproval.value() === mode
    const view = props.state.view()
    return view.status === "ready" && view.mode === mode
  }
  // A connection with `prompt` (this PC, a phone) picks every mode, here and on the new-conversation screen (MUX-15);
  // one with `read` only sees the mode.
  const allowed = (mode: SetMode) => props.state.allowed(mode)
  const children = () => {
    const view = props.state.view()
    return props.session && view.status === "ready" ? view.children : 0
  }
  const note = () => {
    if (!props.session) return text("own.requests.approval.newSessionNote")
    const label = props.state.label()
    if (label === "default") return text("own.requests.approval.defaultNote")
    if (label === "custom") return text("own.requests.approval.customNote")
    return undefined
  }

  const choice = createModeChoice(async (mode) => {
    if (!props.session) {
      newSessionApproval.set(mode)
      return props.onClose()
    }
    try {
      const result = await props.state.set(mode)
      const name = i18n.t(MODE_KEY[result.mode])
      showToast({
        message: result.children
          ? text("own.requests.approval.appliedChildren", { mode: name, n: result.children })
          : text("own.requests.approval.applied", { mode: name }),
      })
      props.onClose()
    } catch (error) {
      console.error("[own-web] session.approval.set failed", error)
      showToast({ message: text("own.requests.approval.failed"), tone: "danger" })
    }
  })

  onMount(() => {
    // The child count may have changed since the pill loaded; the menu shows the router's current number.
    if (props.session) void props.state.reload()
    nextFrame(() => {
      if (!root) return
      const rect = props.anchor?.isConnected ? props.anchor.getBoundingClientRect() : undefined
      const width = root.offsetWidth
      const height = root.offsetHeight
      const left = rect ? Math.min(Math.max(12, rect.right - width), innerWidth - width - 12) : (innerWidth - width) / 2
      const below = rect ? rect.bottom + 6 : 80
      const top = below + height > innerHeight - 12 && rect ? Math.max(12, rect.top - height - 6) : below
      setPlace({ left: Math.max(12, left), top })
      ;(
        root.querySelector<HTMLElement>('[aria-checked="true"]') ??
        root.querySelector<HTMLElement>('[role="menuitemradio"]')
      )?.focus()
    })
    const outside = (event: PointerEvent) => {
      const node = event.target
      if (!(node instanceof Node) || root?.contains(node) || props.anchor?.contains(node)) return
      props.onClose()
    }
    document.addEventListener("pointerdown", outside, true)
    onCleanup(() => document.removeEventListener("pointerdown", outside, true))
  })

  return (
    <div
      ref={root}
      class="own-am"
      role="dialog"
      aria-label={props.session ? text("own.requests.approval.menu") : text("own.requests.approval.newSession")}
      data-testid="approval-menu"
      data-placed={place() ? "true" : "false"}
      style={place() ? { left: `${place()!.left}px`, top: `${place()!.top}px` } : undefined}
      onKeyDown={(event) => {
        if (event.isComposing || event.keyCode === 229) return
        if (event.code === "Escape" || event.key === "Escape") {
          event.preventDefault()
          event.stopPropagation()
          if (choice.confirming()) return choice.cancel()
          props.onClose()
          return
        }
        if (event.code !== "ArrowDown" && event.code !== "ArrowUp") return
        const items = [...(root?.querySelectorAll<HTMLElement>('[role="menuitemradio"]:not(:disabled)') ?? [])]
        const index = items.findIndex((item) => item === document.activeElement)
        const next = items[(index + (event.code === "ArrowDown" ? 1 : items.length - 1)) % items.length]
        if (!next) return
        event.preventDefault()
        next.focus()
      }}
    >
      <p class="own-am-title">
        {props.session ? text("own.requests.approval.menu") : text("own.requests.approval.newSession")}
      </p>
      <div role="menu" aria-orientation="vertical">
        <For each={MODES}>
          {(mode) => (
            <button
              type="button"
              class="own-am-item"
              role="menuitemradio"
              aria-checked={checked(mode)}
              data-mode={mode}
              data-testid={`approval-mode-${mode}`}
              disabled={!allowed(mode) || props.state.pending() !== undefined}
              onClick={() => void choice.choose(mode)}
            >
              <span class="own-rq-check" data-type="radio" aria-hidden="true">
                {checked(mode) ? "✓" : ""}
              </span>
              <span class="own-rq-option-main">
                <span class="own-am-name">{i18n.t(MODE_KEY[mode])}</span>
                <span class="own-rq-option-desc">{describe(mode)}</span>
              </span>
            </button>
          )}
        </For>
      </div>
      <Show when={choice.confirming()}>
        <div
          class="own-am-confirm"
          role="alertdialog"
          aria-label={i18n.t("own.approval.full")}
          data-testid="approval-confirm"
        >
          <p class="own-rq-warn">{i18n.t("own.approval.fullWarn")}</p>
          <div class="own-rq-actions">
            <button type="button" class="own-rq-btn" data-variant="ghost" onClick={() => choice.cancel()}>
              {text("own.requests.approval.cancel")}
            </button>
            <button
              type="button"
              class="own-rq-btn"
              data-variant="primary"
              data-testid="approval-confirm-full"
              ref={(element) => nextFrame(() => element.focus())}
              onClick={() => void choice.confirm()}
            >
              {text("own.requests.approval.confirm")}
            </button>
          </div>
        </div>
      </Show>
      <Show when={children() > 0}>
        <p class="own-am-note" data-testid="approval-children">
          {i18n.t("own.approval.childrenNote", { n: children() })}
        </p>
      </Show>
      <Show when={MODES.every((mode) => !allowed(mode))}>
        <p class="own-am-note" data-testid="approval-no-scope">
          {text("own.requests.approval.noScope")}
        </p>
      </Show>
      <Show when={note()}>{(value) => <p class="own-am-note">{value()}</p>}</Show>
    </div>
  )

  function describe(mode: SetMode) {
    if (mode === "read-only") return i18n.t("own.approval.readOnlyNote")
    if (mode === "full") return i18n.t("own.approval.fullWarn")
    return text("own.requests.approval.askNote")
  }
}
