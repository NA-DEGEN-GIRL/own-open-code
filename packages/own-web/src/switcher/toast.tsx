// Switch notifications (03 §9 "toast"): bottom right, at most 3, 5 s, or 8 s when they carry an action such as
// `되돌리기`. A small own region instead of `@opencode/ui/toast`, which needs the ui i18n context the shell does not
// mount; a shared notification module (bell list, 21.3 FeedItem) can take this over later.
import { createRoot, For, Show } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useI18n } from "@/i18n"

export interface ToastAction {
  readonly label: string
  readonly run: () => void
}

export interface ToastInput {
  readonly message: string
  readonly tone?: "neutral" | "danger"
  readonly action?: ToastAction
  /** Milliseconds; default 5 s, 8 s with an action (03 §9). */
  readonly duration?: number
}

interface ToastItem extends ToastInput {
  readonly id: number
}

const LIMIT = 3

const toasts = createRoot(() => {
  const [state, setState] = createStore<{ items: ToastItem[] }>({ items: [] })
  const timers = new Map<number, ReturnType<typeof setTimeout>>()
  let seq = 0
  const dismiss = (id: number) => {
    clearTimeout(timers.get(id))
    timers.delete(id)
    setState("items", (items) => items.filter((item) => item.id !== id))
  }
  return {
    state,
    dismiss,
    show(input: ToastInput) {
      const id = ++seq
      setState(
        "items",
        produce((items) => {
          items.push({ ...input, id })
          while (items.length > LIMIT) {
            const dropped = items.shift()
            if (dropped) clearTimeout(timers.get(dropped.id))
          }
        }),
      )
      timers.set(
        id,
        setTimeout(() => dismiss(id), input.duration ?? (input.action ? 8_000 : 5_000)),
      )
      return id
    },
  }
})

export const showToast = toasts.show
export const dismissToast = toasts.dismiss

/**
 * Rendered once by the shell, outside the session view it hides under pages, so a toast fired on a page (settings,
 * 다른 도구의 대화) shows too. `role="status"` keeps announcements polite (03 §11).
 */
export function Toasts() {
  const i18n = useI18n()
  return (
    <div class="own-sw-toasts" role="status" aria-live="polite" data-testid="toasts">
      <For each={toasts.state.items}>
        {(item) => (
          <div class="own-sw-toast" data-tone={item.tone ?? "neutral"} data-testid="toast">
            <span class="min-w-0 flex-1">{item.message}</span>
            <Show when={item.action}>
              {(action) => (
                <button
                  type="button"
                  class="own-sw-toast-action own-target"
                  onClick={() => {
                    toasts.dismiss(item.id)
                    action().run()
                  }}
                >
                  {action().label}
                </button>
              )}
            </Show>
            <button
              type="button"
              class="own-sw-toast-close own-target"
              aria-label={i18n.t("own.toast.close")}
              onClick={() => toasts.dismiss(item.id)}
            >
              <span aria-hidden="true" class="own-ico own-ico-x" />
            </button>
          </div>
        )}
      </For>
    </div>
  )
}
